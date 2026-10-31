/**
 * 検索の検証・計画・実行（検索要件の中核）。
 *
 * 「取引年月日・取引金額・取引先で検索できる」「日付・金額は範囲指定できる」
 * 「任意の 2 項目以上の組み合わせで検索できる」という電帳法の検索要件を、
 * 次の 2 段階で満たす:
 *
 * 1. `planQuery` が検索条件を「どの索引を何回引くか」へ変換する。
 *    範囲条件はパーティションを列挙することで単一アクセスへ分解する。
 * 2. `executeQuery` が計画どおりに索引を引き、索引で表現できなかった
 *    残条件（`QueryResidual`）を取得後に適用して、重複排除・整列・件数制限を行う。
 *
 * 計画は `QueryPlan.rationale` に日本語で理由を持つ。適合性検証（監査）は
 * `describeSearchCapability` の返り値を証跡として使い、さらにこの計画器を
 * 実際に呼び出して「計画が作れること」を確認する（主張ではなく実測で示す）。
 *
 * 設計方針:
 * - 読み取りアイテム数の最小化を優先する。アクセス回数が 1 回増えても、
 *   パーティションが細かく分かれる索引の方が取得件数は少ない。
 * - 片側のみの日付指定は、複合索引の月走査では無駄が多いため
 *   `by-counterparty` のソートキー範囲（1 アクセス）へ切り替える。
 * - 索引だけで表現できない条件（書類種別など）は残条件として日本語で説明する。
 */

import type {
  ExportFormat,
  IndexQuery,
  IndexRecord,
  IndexStore,
  IsoDate,
  QueryPlan,
  QueryResidual,
  SearchCapability,
  SearchField,
  VoucherQuery,
} from './types.js';
import { ValidationError } from './errors.js';
import { compareIsoDate, isIsoDateInRange, isValidIsoDate } from './time.js';
import {
  INDEX_NAMES,
  MAX_AMOUNT_YEN,
  amountBucketsCovering,
  counterpartyPartition,
  datePartition,
  encodeAmount,
  normalizeCounterparty,
} from './index-keys.js';

// ---------------------------------------------------------------------------
// 定数
// ---------------------------------------------------------------------------

/**
 * 片側だけ日付が指定された場合に展開する月パーティション数の上限。
 *
 * 120 か月 = 10 年。法定保存期間 7 年に対して 3 年の余裕があり、
 * 保存対象の証憑はこの範囲に必ず収まる。両端が指定された検索でも
 * この本数を超える範囲は受け付けない（索引アクセスの爆発を防ぐ）。
 */
export const MAX_MONTH_ACCESSES = 120;

/** 2 項目組み合わせ検索の証明用クエリ（1 か月・1 万円に収まる代表的な条件）。 */
const COMBINATION_PROBES: readonly { readonly combination: string; readonly query: VoucherQuery }[] = [
  {
    combination: 'transactionDate+amount',
    query: { dateFrom: '2026-01-01', dateTo: '2026-01-31', amountMin: 0, amountMax: 9_999 },
  },
  {
    combination: 'transactionDate+counterparty',
    query: { dateFrom: '2026-01-01', dateTo: '2026-01-31', counterparty: 'サンプル商事' },
  },
  {
    combination: 'amount+counterparty',
    query: { amountMin: 0, amountMax: 9_999, counterparty: 'サンプル商事' },
  },
];

/**
 * 2 項目以上の組み合わせ検索として公開する組み合わせ。
 *
 * 実際に `planQuery` が計画を返せることを確認したものだけを
 * `describeSearchCapability` が公開する（宣言と実装の乖離を防ぐ）。
 * 組み合わせの定義は `COMBINATION_PROBES` が唯一の情報源である。
 */
export const TWO_FIELD_COMBINATIONS: readonly string[] = COMBINATION_PROBES.map(
  (probe) => probe.combination,
);

/**
 * 日付ソートキーの上限に付ける最大文字。
 *
 * `sk` は `<date>#<voucherId>` なので、指定日の全証憑を含めるには
 * 「日付 + `#` + どの ID よりも大きい文字」を上限にすればよい。
 * U+10FFFF は UTF-16 コード単位順でも UTF-8 バイト順でも最大の文字。
 */
const SORT_KEY_SUFFIX_MAX = '\u{10FFFF}';

/** 正規化可能な残条件（読み取り専用の `QueryResidual` を組み立てるための作業型）。 */
type MutableResidual = { -readonly [K in keyof QueryResidual]: QueryResidual[K] };

// ---------------------------------------------------------------------------
// 検索条件の検証
// ---------------------------------------------------------------------------

/**
 * 検索条件の妥当性を検証する。
 *
 * 次の場合は `ValidationError` を投げる:
 * - 条件が 1 つも無い（`limit` や `order` だけでは検索にならない）
 * - `dateFrom` / `dateTo` が `YYYY-MM-DD` の実在する日付でない
 * - `dateFrom > dateTo`
 * - `amountMin` / `amountMax` が 0 以上の整数（円）でない
 * - `amountMin > amountMax`
 * - `counterparty` が正規化すると空文字になる（法人格だけ、空白だけ など）
 *
 * `limit` は件数制限であり検索条件ではないため、ここでは検証しない
 * （`executeQuery` が 0 件以上の整数に丸める）。
 *
 * @throws ValidationError 上記のいずれかに該当する場合
 */
export function validateQuery(query: VoucherQuery): void {
  const hasAnyFilter =
    query.dateFrom !== undefined ||
    query.dateTo !== undefined ||
    query.amountMin !== undefined ||
    query.amountMax !== undefined ||
    query.counterparty !== undefined ||
    query.documentType !== undefined;
  if (!hasAnyFilter) {
    throw new ValidationError(
      '検索条件が空です。取引年月日・取引金額・取引先のいずれかを指定してください（limit / order だけでは検索できません）',
    );
  }

  if (query.dateFrom !== undefined && !isValidIsoDate(query.dateFrom)) {
    throw new ValidationError(`dateFrom が不正です（YYYY-MM-DD 形式の実在する日付を指定）: ${query.dateFrom}`);
  }
  if (query.dateTo !== undefined && !isValidIsoDate(query.dateTo)) {
    throw new ValidationError(`dateTo が不正です（YYYY-MM-DD 形式の実在する日付を指定）: ${query.dateTo}`);
  }
  if (
    query.dateFrom !== undefined &&
    query.dateTo !== undefined &&
    compareIsoDate(query.dateFrom, query.dateTo) > 0
  ) {
    throw new ValidationError(`日付範囲が逆転しています（dateFrom: ${query.dateFrom} / dateTo: ${query.dateTo}）`);
  }

  if (query.amountMin !== undefined) {
    assertAmountFilter('amountMin', query.amountMin);
  }
  if (query.amountMax !== undefined) {
    assertAmountFilter('amountMax', query.amountMax);
  }
  if (
    query.amountMin !== undefined &&
    query.amountMax !== undefined &&
    query.amountMin > query.amountMax
  ) {
    throw new ValidationError(
      `金額範囲が逆転しています（amountMin: ${query.amountMin} / amountMax: ${query.amountMax}）`,
    );
  }

  if (query.counterparty !== undefined && normalizeCounterparty(query.counterparty).length === 0) {
    throw new ValidationError(
      `取引先名を指定してください（正規化すると空文字になります）: ${JSON.stringify(query.counterparty)}`,
    );
  }
}

/** 金額条件が 0 以上の整数（円）かを検証する。 */
function assertAmountFilter(field: 'amountMin' | 'amountMax', value: number): void {
  if (!Number.isSafeInteger(value)) {
    throw new ValidationError(`${field} は 0 以上の整数（円）で指定してください: ${String(value)}`);
  }
  if (value < 0) {
    throw new ValidationError(`${field} に負数は指定できません: ${value}`);
  }
}

// ---------------------------------------------------------------------------
// 検索計画
// ---------------------------------------------------------------------------

/**
 * 検索条件から実行計画（どの索引を何回引くか）を組み立てる。
 *
 * 決定表（`by-counterparty-date` などの選定理由は `rationale` に日本語で入る）:
 *
 * | 検索条件 | 索引 | アクセス数 |
 * |---|---|---|
 * | 取引先 + 日付（両端指定） | by-counterparty-date | 範囲内の月数 |
 * | 取引先 + 日付（片側のみ） | by-counterparty | 1 |
 * | 取引先 + 金額 | by-counterparty-amount | 範囲を覆う金額バケット数（最大 16） |
 * | 取引先のみ | by-counterparty | 1 |
 * | 日付のみ（両端指定） | by-date | 範囲内の月数 |
 * | 日付のみ（片側のみ） | by-date | 最大 120 か月 |
 * | 日付 + 金額 | by-date + 金額の残条件 | 範囲内の月数 |
 * | 金額のみ | by-amount | 範囲を覆う金額バケット数（最大 16） |
 * | 書類種別のみ | by-amount（全バケット）+ 書類種別の残条件 | 最大 16 |
 *
 * 複合索引を使うのは「読み取り件数」を最小化するためである。取引先の
 * 単独索引は 1 アクセスで済むが 1 社の全履歴を読むことになる。
 *
 * @throws ValidationError 検索条件が不正な場合、または日付のみの検索で範囲が 120 か月を超える場合
 */
export function planQuery(query: VoucherQuery): QueryPlan {
  validateQuery(query);

  const counterparty =
    query.counterparty === undefined ? undefined : normalizeCounterparty(query.counterparty);
  const hasCounterparty = counterparty !== undefined && counterparty.length > 0;
  const hasDate = query.dateFrom !== undefined || query.dateTo !== undefined;
  const hasAmount = query.amountMin !== undefined || query.amountMax !== undefined;

  // 書類種別はどの索引にも無いため、常に取得後の残条件とする。
  const residual: MutableResidual = {};
  if (query.documentType !== undefined) {
    residual.documentType = query.documentType;
  }

  // --- 取引先 + 日付（金額の有無を問わず日付で複合索引を使う） ---------------
  if (hasCounterparty && hasDate) {
    const expansion = expandMonths(query.dateFrom, query.dateTo);
    if (expansion.capped || !expansion.bounded) {
      // 月走査が不能/過大、または片側未指定: 取引先索引の sk 範囲で日付を絞る。
      if (hasAmount) {
        residual.amountMin = query.amountMin;
        residual.amountMax = query.amountMax;
      }
      return buildPlan(
        counterpartyAccesses(counterparty, query),
        residual,
        `日付の片側が未指定、または範囲が ${MAX_MONTH_ACCESSES} か月を超えるため、` +
          '複合索引 by-counterparty-date の月走査（最大 ' +
          `${MAX_MONTH_ACCESSES} か月）は無駄が多い。` +
          '取引先索引 by-counterparty のソートキー範囲で日付を絞り、1 アクセスで取得する。' +
          residualNote(residual),
      );
    }

    const accesses = monthAccesses('by-counterparty-date', counterparty, expansion.months, query);
    if (hasAmount) {
      residual.amountMin = query.amountMin;
      residual.amountMax = query.amountMax;
    }
    return buildPlan(
      accesses,
      residual,
      `取引先と取引年月日の複合索引 by-counterparty-date を使い、` +
        `${expansion.months.length} か月分のパーティション（${monthRangeLabel(expansion.months)}）を走査する。` +
        '取引先の単独索引なら 1 アクセスで済むが 1 社の全履歴を読むことになるため、' +
        'パーティションを取引先と月で分割して取得件数を抑える計画を選んだ。' +
        residualNote(residual),
    );
  }

  // --- 取引先 + 金額 ------------------------------------------------------
  if (hasCounterparty && hasAmount) {
    const accesses = counterpartyAmountAccesses(counterparty, query);
    return buildPlan(
      accesses,
      residual,
      `取引先と金額桁でパーティションが分かれる複合索引 by-counterparty-amount を使い、` +
        `金額範囲を覆う ${accesses.length} 個の金額バケットをソートキーの範囲指定で走査する。` +
        '取引先の単独索引では金額を取得後に判定することになるため、' +
        '取得件数が最小になるこの計画を選んだ。' +
        residualNote(residual),
    );
  }

  // --- 取引先のみ --------------------------------------------------------
  if (hasCounterparty) {
    const accesses = counterpartyAccesses(counterparty, query);
    return buildPlan(
      accesses,
      residual,
      '取引先索引 by-counterparty の単一パーティションを 1 アクセスで読む。' +
        '取引年月日の範囲はソートキー（<date>#<voucherId>）の範囲指定で絞る。' +
        residualNote(residual),
    );
  }

  // --- 日付 + 金額 -------------------------------------------------------
  if (hasDate && hasAmount) {
    const expansion = expandMonths(query.dateFrom, query.dateTo);
    if (expansion.capped) {
      // 月数が多すぎる場合は金額索引（最大 16 バケット）へ切り替える。
      residual.dateFrom = query.dateFrom;
      residual.dateTo = query.dateTo;
      const accesses = amountAccesses(query);
      return buildPlan(
        accesses,
        residual,
        `日付範囲が ${MAX_MONTH_ACCESSES} か月を超えるため、索引 by-date の月走査は実行しない。` +
          `金額の桁クラスでパーティション化された索引 by-amount の ${accesses.length} バケットを走査し、` +
          '日付は取得後の残条件で判定する。' +
          residualNote(residual),
      );
    }
    residual.amountMin = query.amountMin;
    residual.amountMax = query.amountMax;
    const accesses = monthAccesses('by-date', undefined, expansion.months, query);
    return buildPlan(
      accesses,
      residual,
      `日付の範囲は月次パーティション D#yyyy-mm を跨ぐため、索引 by-date の ` +
        `${expansion.months.length} か月分（${monthRangeLabel(expansion.months)}）を走査する。` +
        '金額はソートキーの中間要素（<date>#<amount>#<voucherId>）で単独の範囲指定にできないため、' +
        '取得後の残条件で判定する。' +
        residualNote(residual),
    );
  }

  // --- 日付のみ ---------------------------------------------------------
  if (hasDate) {
    const expansion = expandMonths(query.dateFrom, query.dateTo);
    if (expansion.capped) {
      throw new ValidationError(
        `日付範囲が広すぎます（最大 ${MAX_MONTH_ACCESSES} か月 = 10 年）。` +
          '保存期間 7 年に収まる範囲へ分割して検索してください',
      );
    }
    const accesses = monthAccesses('by-date', undefined, expansion.months, query);
    const openNote = expansion.bounded
      ? ''
      : `両端の指定が無いため、月パーティションを最大 ${MAX_MONTH_ACCESSES} か月（10 年）分展開した。` +
        '法定保存期間 7 年に対して十分な余裕がある。';
    return buildPlan(
      accesses,
      residual,
      `日付の範囲指定は月次パーティション D#yyyy-mm を跨ぐため、索引 by-date の ` +
        `${expansion.months.length} か月分（${monthRangeLabel(expansion.months)}）を走査する。` +
        openNote +
        '日付に代わる索引は無いため、この計画が唯一の漏れのない方法である。' +
        residualNote(residual),
    );
  }

  // --- 金額のみ ---------------------------------------------------------
  if (hasAmount) {
    const accesses = amountAccesses(query);
    return buildPlan(
      accesses,
      residual,
      `金額は桁クラス（A#00001 = 1 桁, ... A#00016 = 16 桁）でパーティション化されている。` +
        `索引 by-amount の ${accesses.length} バケットを、16 桁金額のソートキー範囲で絞って走査する。` +
        '金額の範囲に含まれるバケットだけを列挙するため、全件走査にはならない。' +
        residualNote(residual),
    );
  }

  // --- 書類種別のみ（索引が無い） ---------------------------------------
  // 書類種別をキーに持つ索引は無いが、すべての証憑は必ず by-amount の
  // いずれかの桁クラスへ入るため、全バケット（最大 16）を走査すれば
  // 漏れなく全件を対象にできる。書類種別は残条件として判定する。
  if (query.documentType !== undefined) {
    const accesses = amountAccesses({});
    return buildPlan(
      accesses,
      residual,
      '書類種別をキーに持つ索引は無い。ただしすべての証憑は金額の桁クラスで' +
        `パーティション化された索引 by-amount のいずれかに入るため、全 ${accesses.length} バケット` +
        `（0 円〜${MAX_AMOUNT_YEN} 円）を走査して全件を漏れなく対象とする。` +
        '索引アクセスは最大 16 回に収まり、書類種別は取得後の残条件で判定する。' +
        residualNote(residual),
    );
  }

  // ここには到達しない（validateQuery が「条件なし」を拒否している）。
  throw new ValidationError('検索条件が空です。取引年月日・取引金額・取引先のいずれかを指定してください');
}

/** 計画を組み立てる（`estimatedAccesses` は索引アクセス数）。 */
function buildPlan(
  accesses: readonly IndexQuery[],
  residual: MutableResidual,
  rationale: string,
): QueryPlan {
  return {
    accesses,
    residual,
    estimatedAccesses: accesses.length,
    rationale,
  };
}

/** 残条件の説明を文末に付ける。 */
function residualNote(residual: MutableResidual): string {
  const fields: string[] = [];
  if (residual.counterparty !== undefined) {
    fields.push('取引先');
  }
  if (residual.amountMin !== undefined || residual.amountMax !== undefined) {
    fields.push('金額');
  }
  if (residual.dateFrom !== undefined || residual.dateTo !== undefined) {
    fields.push('日付');
  }
  if (residual.documentType !== undefined) {
    fields.push('書類種別');
  }
  if (fields.length === 0) {
    return '索引のキーだけで全条件を判定できる。';
  }
  return `索引で表現できない残条件（${fields.join('・')}）は取得後に判定する。`;
}

// ---------------------------------------------------------------------------
// 月パーティションの展開
// ---------------------------------------------------------------------------

/** 月展開の結果。 */
interface MonthExpansion {
  /** `YYYY-MM` の昇順一覧。`capped` のときは空。 */
  readonly months: readonly string[];
  /** 両端が指定されたか。 */
  readonly bounded: boolean;
  /** 指定範囲が `MAX_MONTH_ACCESSES` を超えたか。 */
  readonly capped: boolean;
}

/**
 * 日付範囲を月パーティションの一覧へ展開する。
 *
 * 片側のみの指定は最大 `MAX_MONTH_ACCESSES` か月へ展開する
 * （保存期間 7 年に余裕を持たせた 10 年分）。
 */
function expandMonths(from: IsoDate | undefined, to: IsoDate | undefined): MonthExpansion {
  const MIN_MONTH_ORDINAL = 0; // 0000-01
  const MAX_MONTH_ORDINAL = 9999 * 12 + 11; // 9999-12

  if (from === undefined && to === undefined) {
    return { months: [], bounded: true, capped: true };
  }

  if (from !== undefined && to !== undefined) {
    const fromOrdinal = toMonthOrdinal(from);
    const toOrdinal = toMonthOrdinal(to);
    const span = toOrdinal - fromOrdinal + 1;
    if (span > MAX_MONTH_ACCESSES) {
      return { months: [], bounded: true, capped: true };
    }
    return { months: monthList(fromOrdinal, toOrdinal), bounded: true, capped: false };
  }

  if (from !== undefined) {
    const start = toMonthOrdinal(from);
    return {
      months: monthList(start, Math.min(start + MAX_MONTH_ACCESSES - 1, MAX_MONTH_ORDINAL)),
      bounded: false,
      capped: false,
    };
  }

  // ここに来るのは to のみ指定の場合（上で from/to の全組み合わせを処理済み）。
  if (to === undefined) {
    return { months: [], bounded: false, capped: true };
  }
  const end = toMonthOrdinal(to);
  return {
    months: monthList(Math.max(end - MAX_MONTH_ACCESSES + 1, MIN_MONTH_ORDINAL), end),
    bounded: false,
    capped: false,
  };
}

/** 日付を月番号（`year * 12 + month - 1`）へ変換する。 */
function toMonthOrdinal(isoDate: IsoDate): number {
  const year = Number.parseInt(isoDate.slice(0, 4), 10);
  const month = Number.parseInt(isoDate.slice(5, 7), 10);
  return year * 12 + (month - 1);
}

/** 月番号の範囲を `YYYY-MM` の昇順配列へ変換する。 */
function monthList(fromOrdinal: number, toOrdinal: number): readonly string[] {
  const months: string[] = [];
  for (let ordinal = fromOrdinal; ordinal <= toOrdinal; ordinal += 1) {
    const year = Math.floor(ordinal / 12);
    const month = (ordinal % 12) + 1;
    months.push(`${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`);
  }
  return months;
}

/** 月一覧を `2026-01〜2026-03` のような表示用文字列にする。 */
function monthRangeLabel(months: readonly string[]): string {
  const first = months[0];
  const last = months[months.length - 1];
  if (first === undefined || last === undefined) {
    return 'なし';
  }
  return first === last ? first : `${first}〜${last}`;
}

// ---------------------------------------------------------------------------
// 索引アクセスの組み立て
// ---------------------------------------------------------------------------

/**
 * `by-counterparty` の単一アクセスを組み立てる。
 *
 * `sk` は `<date>#<voucherId>` なので、日付の範囲をソートキー範囲で表現できる。
 */
function counterpartyAccesses(counterparty: string, query: VoucherQuery): readonly IndexQuery[] {
  const access: MutableIndexQuery = {
    index: 'by-counterparty',
    partitionKey: counterpartyPartition(counterparty),
  };
  if (query.dateFrom !== undefined) {
    access.sortKeyFrom = `${query.dateFrom}#`;
  }
  if (query.dateTo !== undefined) {
    access.sortKeyTo = `${query.dateTo}#${SORT_KEY_SUFFIX_MAX}`;
  }
  return [access];
}

/** 読み取り専用の `IndexQuery` を組み立てるための作業型。 */
type MutableIndexQuery = { -readonly [K in keyof IndexQuery]: IndexQuery[K] };

/**
 * 月パーティションを走査するアクセスを組み立てる。
 *
 * 最初の月は `dateFrom` 以降、最後の月は `dateTo` 以前にソートキーを絞る。
 * `by-date` の `sk` は `<date>#<amount>#<voucherId>`、
 * `by-counterparty-date` は `<date>#<voucherId>` であり、
 * どちらも日付が先頭なので同じ範囲指定が使える。
 */
function monthAccesses(
  index: 'by-date' | 'by-counterparty-date',
  counterparty: string | undefined,
  months: readonly string[],
  query: VoucherQuery,
): readonly IndexQuery[] {
  const accesses: IndexQuery[] = [];
  for (const [position, month] of months.entries()) {
    const monthPartition = datePartition(`${month}-01`);
    const partitionKey =
      index === 'by-date'
        ? monthPartition
        : `${counterpartyPartition(counterparty ?? '')}#${monthPartition}`;
    const access: MutableIndexQuery = { index, partitionKey };
    if (position === 0 && query.dateFrom !== undefined) {
      access.sortKeyFrom = `${query.dateFrom}#`;
    }
    if (position === months.length - 1 && query.dateTo !== undefined) {
      access.sortKeyTo = `${query.dateTo}#${SORT_KEY_SUFFIX_MAX}`;
    }
    accesses.push(access);
  }
  return accesses;
}

/**
 * `by-amount` の金額バケット走査アクセスを組み立てる。
 *
 * 各バケットの `sk` は `<amount 16 桁>#<voucherId>` なので、
 * 金額範囲の 16 桁文字列をそのまま下限・上限に使える
 * （バケットは桁クラスなので、範囲内の金額は必ずこの範囲に収まる）。
 */
function amountAccesses(query: Pick<VoucherQuery, 'amountMin' | 'amountMax'>): readonly IndexQuery[] {
  const lower = encodeAmount(query.amountMin ?? 0);
  const upper = encodeAmount(query.amountMax ?? MAX_AMOUNT_YEN);
  return amountBucketsCovering(query.amountMin, query.amountMax).map((bucket) => ({
    index: 'by-amount',
    partitionKey: bucket,
    sortKeyFrom: `${lower}#`,
    sortKeyTo: `${upper}#${SORT_KEY_SUFFIX_MAX}`,
  }));
}

/** `by-counterparty-amount` の金額バケット走査アクセスを組み立てる。 */
function counterpartyAmountAccesses(
  counterparty: string,
  query: VoucherQuery,
): readonly IndexQuery[] {
  const lower = encodeAmount(query.amountMin ?? 0);
  const upper = encodeAmount(query.amountMax ?? MAX_AMOUNT_YEN);
  const counterpartyKey = counterpartyPartition(counterparty);
  return amountBucketsCovering(query.amountMin, query.amountMax).map((bucket) => ({
    index: 'by-counterparty-amount',
    partitionKey: `${counterpartyKey}#${bucket}`,
    sortKeyFrom: `${lower}#`,
    sortKeyTo: `${upper}#${SORT_KEY_SUFFIX_MAX}`,
  }));
}

// ---------------------------------------------------------------------------
// 残条件の判定
// ---------------------------------------------------------------------------

/**
 * 索引で表現できなかった残条件をレコードに対して判定する。
 *
 * 残条件が空なら常に `true`。`counterparty` は正規化してから比較する
 * （片側だけが正規化済みでも一致するようにするため）。
 */
export function matchesResidual(record: IndexRecord, residual: QueryResidual): boolean {
  if (residual.counterparty !== undefined) {
    if (normalizeCounterparty(residual.counterparty) !== normalizeCounterparty(record.counterpartyNormalized)) {
      return false;
    }
  }
  if (residual.documentType !== undefined && record.documentType !== residual.documentType) {
    return false;
  }
  if (residual.amountMin !== undefined && record.amountYen < residual.amountMin) {
    return false;
  }
  if (residual.amountMax !== undefined && record.amountYen > residual.amountMax) {
    return false;
  }
  if (!isIsoDateInRange(record.transactionDate, residual.dateFrom, residual.dateTo)) {
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// 実行
// ---------------------------------------------------------------------------

/**
 * 検索計画を索引ストアに対して実行し、条件に合うレコードを返す。
 *
 * - 複数の索引アクセスの結果は `voucherId` で重複排除する。
 * - 計画の残条件を適用する。
 * - `query.order`（既定 `date-desc`）で整列する。同順位は台帳の連番で
 *   決めるため、出力は常に決定的になる。
 * - `query.limit` があれば先頭からその件数に切る（0 以下は 0 件）。
 */
export async function executeQuery(
  query: VoucherQuery,
  plan: QueryPlan,
  store: IndexStore,
): Promise<readonly IndexRecord[]> {
  const comparator = ORDER_COMPARATORS[query.order ?? 'date-desc'];
  const byVoucherId = new Map<string, IndexRecord>();
  for (const access of plan.accesses) {
    const records = await store.query(access);
    for (const record of records) {
      if (byVoucherId.has(record.voucherId)) {
        continue;
      }
      if (!matchesResidual(record, plan.residual)) {
        continue;
      }
      byVoucherId.set(record.voucherId, record);
    }
  }

  const sorted = [...byVoucherId.values()].sort(comparator);
  const limit = normalizedLimit(query.limit);
  return limit === undefined ? sorted : sorted.slice(0, limit);
}

/** 並び順ごとの比較関数。同順位の決め方まで固定して出力を決定的にする。 */
const ORDER_COMPARATORS: Readonly<
  Record<NonNullable<VoucherQuery['order']>, (left: IndexRecord, right: IndexRecord) => number>
> = {
  // 取引年月日の降順（同日は台帳の新しい順）。
  'date-desc': (left, right) =>
    compareIsoDate(right.transactionDate, left.transactionDate) || right.sequence - left.sequence,
  // 取引年月日の昇順（同日は台帳の古い順）。
  'date-asc': (left, right) =>
    compareIsoDate(left.transactionDate, right.transactionDate) || left.sequence - right.sequence,
  // 金額の降順（同額は日付の新しい順、さらに同日は台帳の新しい順）。
  'amount-desc': (left, right) =>
    right.amountYen - left.amountYen ||
    compareIsoDate(right.transactionDate, left.transactionDate) ||
    right.sequence - left.sequence,
};

/** 件数制限を「0 以上の整数」または「指定なし」へ正規化する。 */
function normalizedLimit(limit: number | undefined): number | undefined {
  if (limit === undefined || !Number.isFinite(limit)) {
    return undefined;
  }
  return Math.max(0, Math.floor(limit));
}

// ---------------------------------------------------------------------------
// 検索要件の充足状況（監査への証跡）
// ---------------------------------------------------------------------------

/**
 * 検索要件の充足状況を返す。適合性検証（`SearchCapability`）が参照する。
 *
 * この関数は定数を返すだけではなく、**計画器に実際に検索を計画させて**
 * 充足を判定する。したがって「索引を 5 本定義した」という宣言と
 * 「実際にその索引で 3 項目・範囲・2 項目組み合わせを計画できる」という
 * 実装が乖離すれば、返り値が不足側へ変わり、監査で検出できる。
 *
 * - `searchableFields`: 取引年月日・金額・取引先のうち、計画が作れる項目
 * - `supportsDateRange` / `supportsAmountRange`: 範囲指定の計画が作れるか
 * - `twoFieldCombinations`: `TWO_FIELD_COMBINATIONS` のうち計画が作れる組み合わせ
 * - `exportFormats`: 税務調査のダウンロードの求めに応える形式（CSV / JSON）
 * - `indexes`: 実装済みの索引（`INDEX_NAMES`）
 */
export function describeSearchCapability(): SearchCapability {
  const dateRangeQuery: VoucherQuery = { dateFrom: '2026-01-01', dateTo: '2026-01-31' };
  const amountRangeQuery: VoucherQuery = { amountMin: 0, amountMax: 9_999 };
  const counterpartyQuery: VoucherQuery = { counterparty: 'サンプル商事' };

  const supportsDateRange = isPlannable(dateRangeQuery);
  const supportsAmountRange = isPlannable(amountRangeQuery);
  const supportsCounterparty = isPlannable(counterpartyQuery);

  const searchableFields: SearchField[] = [];
  if (supportsDateRange) {
    searchableFields.push('transactionDate');
  }
  if (supportsAmountRange) {
    searchableFields.push('amount');
  }
  if (supportsCounterparty) {
    searchableFields.push('counterparty');
  }

  const twoFieldCombinations = COMBINATION_PROBES.filter((probe) => isPlannable(probe.query)).map(
    (probe) => probe.combination,
  );

  const exportFormats: readonly ExportFormat[] = ['csv', 'json'];

  return {
    searchableFields,
    supportsDateRange,
    supportsAmountRange,
    supportsCounterparty,
    twoFieldCombinations,
    exportFormats,
    indexes: INDEX_NAMES,
  };
}

/** その検索条件が計画可能（索引アクセスが 1 回以上）かを試す。 */
function isPlannable(query: VoucherQuery): boolean {
  try {
    return planQuery(query).accesses.length > 0;
  } catch {
    return false;
  }
}
