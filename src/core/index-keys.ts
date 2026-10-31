/**
 * 検索索引のキー設計（検索要件の実装基盤）。
 *
 * 電子帳簿保存法の検索要件は、①取引年月日 ②取引金額 ③取引先 の 3 項目で
 * 検索でき、日付・金額は範囲指定でき、任意の 2 項目以上の組み合わせでも
 * 検索できることを求める。これを**索引のキー構造そのもの**で保証する。
 *
 * 設計方針:
 * - 索引は 5 本。単独 3 本 + 2 項目複合 2 本で、要件の「2 項目以上の組み合わせ」を
 *   単一のパーティションクエリ（`pk` 完全一致 + `sk` 範囲）で表現できる。
 * - 金額は整数円を 16 桁ゼロ埋めした文字列で持つ。これにより
 *   `sk` の辞書順比較がそのまま金額の数値順比較になる（`encodeAmount`）。
 * - 範囲検索は「パーティションを跨ぐ」ため、パーティション関数が
 *   - 日付: 月（`D#yyyy-mm`）
 *   - 金額: 桁クラス（`A#00001` = 1 桁, ... `A#00016` = 16 桁）
 *   で分割する。範囲に含まれるパーティションを列挙すれば、
 *   その本数だけの索引アクセスで漏れなく範囲検索できる。
 * - 取引先は正規化（`normalizeCounterparty`）してからキーに使う。全角/半角、
 *   空白、法人格表記の揺れを同一視しないと、同じ取引先を検索で引けない。
 */

import type { DocumentType, IndexEntry, IndexName, IndexRecord, IsoDate } from './types.js';
import { ValidationError } from './errors.js';
import { isValidIsoDate } from './time.js';

// ---------------------------------------------------------------------------
// 索引の一覧
// ---------------------------------------------------------------------------

/**
 * 存在する索引の全一覧（表記順はこの順序を正とする）。
 *
 * `deriveIndexEntries` はこの順序で 5 件のエントリを返し、
 * `LocalIndexStore.stats()` もこの順序で件数を返す。
 */
export const INDEX_NAMES: readonly IndexName[] = [
  'by-date', // 取引年月日
  'by-amount', // 取引金額
  'by-counterparty', // 取引先
  'by-counterparty-date', // 取引先 + 取引年月日
  'by-counterparty-amount', // 取引先 + 取引金額
];

/** 日付パーティションの接頭辞（`D#yyyy-mm`）。 */
export const DATE_PARTITION_PREFIX = 'D#';

/** 金額バケットパーティションの接頭辞（`A#00001`〜`A#00016`）。 */
export const AMOUNT_BUCKET_PREFIX = 'A#';

/** 取引先パーティションの接頭辞（`C#<正規化名>`）。 */
export const COUNTERPARTY_PARTITION_PREFIX = 'C#';

/** 金額のエンコード幅（桁数）。 */
export const AMOUNT_ENCODING_WIDTH = 16;

/**
 * 金額の上限（円）。
 *
 * `Number.MAX_SAFE_INTEGER`（9,007,199,254,740,991）は 16 桁なので、
 * エンコード幅 16 桁で全領域を表現でき、辞書順 = 数値順が常に成り立つ。
 * 証憑 1 件の金額として現実的な上限はこれより遥かに小さい。
 */
export const MAX_AMOUNT_YEN = Number.MAX_SAFE_INTEGER;

/** 金額バケット（桁クラス）のゼロ埋め幅。 */
const AMOUNT_BUCKET_WIDTH = 5;

/**
 * 法人格表記として除去するトークン。
 *
 * NFKC 正規化の後に適用するため、`㈱` は `(株)`、`㈲` は `(有)`、
 * `（株）` は `(株)` に揃っている前提でよい。
 * 「株式会社サンプル商事」と「サンプル商事(株)」を同じキーにするのが目的。
 */
const CORPORATE_FORM_TOKENS: readonly string[] = [
  '株式会社',
  '有限会社',
  '合同会社',
  '合資会社',
  '合名会社',
  '社団法人',
  '財団法人',
  '(株)',
  '(有)',
  '(合)',
  '(資)',
  '(名)',
];

// ---------------------------------------------------------------------------
// 取引先の正規化
// ---------------------------------------------------------------------------

/**
 * 取引先名を検索用に正規化する。
 *
 * 規則（順序が意味を持つ）:
 * 1. NFKC 正規化: 全角英数字・全角括弧・半角カタカナを通常形へ寄せる
 *    （`Ａ`→`A`、`（株）`→`(株)`、`㈱`→`(株)`、`　`→ 半角空白）。
 * 2. 空白の完全除去: 半角・全角スペース、タブ、改行など `\s` をすべて削除する。
 *    「サンプル 商事」と「サンプル商事」を同一視するため。
 * 3. ASCII 小文字化: `ABC商事` と `abc商事` を同一視する
 *    （ひらがな・カタカナ・漢字は変化しない）。
 * 4. 法人格表記の除去: `株式会社` / `有限会社` / `(株)` / `(有)` などを
 *    文字列中のどこからでも取り除く。これにより
 *    「株式会社サンプル商事」と「サンプル商事(株)」がどちらも `サンプル商事` になる。
 * 5. 前後の空白除去（3 で除去済みだが、法人格除去後の残りを整えるため）。
 *
 * 冪等（`normalize(normalize(x)) === normalize(x)`）である。
 * 法人格のみの名前は空文字になる（索引化の際は `ValidationError` とする）。
 */
export function normalizeCounterparty(name: string): string {
  // 1. 全角/半角・互換文字の統一。
  let normalized = name.normalize('NFKC');
  // 2. 空白（半角・全角・タブ・改行）を完全に除去する。
  normalized = normalized.replace(/[\s\u3000]+/gu, '');
  // 3. ASCII のみ小文字化する（日本語の大小は無いので影響しない）。
  normalized = normalized.toLowerCase();
  // 4. 法人格表記を除去する。表記の位置は問わない。
  for (const token of CORPORATE_FORM_TOKENS) {
    normalized = normalized.replaceAll(token, '');
  }
  // 5. 残余の空白を除去する（法人格除去で空白が残るケースへの備え）。
  return normalized.trim();
}

// ---------------------------------------------------------------------------
// 金額のエンコード
// ---------------------------------------------------------------------------

/**
 * 金額（0 以上の整数円）を、数値順と辞書順が一致する固定幅文字列へ変換する。
 *
 * 例: `0` → `0000000000000000`、`12` → `0000000000000012`、
 *     `999999999999` → `0000999999999999`。
 *
 * 16 桁ゼロ埋めなので、文字列比較の結果は常に数値比較の結果と一致する
 * （`encodeAmount(a) < encodeAmount(b) ⇔ a < b`）。この性質によって
 * DynamoDB の `sk` 範囲検索がそのまま金額の範囲検索になる。
 *
 * @throws ValidationError 負数・非整数・安全整数でない値の場合
 */
export function encodeAmount(amountYen: number): string {
  assertAmountYen(amountYen);
  return String(amountYen).padStart(AMOUNT_ENCODING_WIDTH, '0');
}

/**
 * `encodeAmount` の逆変換。索引のソートキーから金額を復元する。
 *
 * @throws ValidationError 16 桁の数字列でない場合、または復元値が不正な場合
 */
export function decodeAmount(encoded: string): number {
  if (!/^\d{16}$/.test(encoded)) {
    throw new ValidationError(`金額キーの形式が不正です（16 桁の数字列を期待）: ${JSON.stringify(encoded)}`);
  }
  const value = Number.parseInt(encoded, 10);
  assertAmountYen(value);
  return value;
}

/**
 * 金額のバケットパーティション（桁クラス）を返す。
 *
 * `amountBucket(0)` 〜 `amountBucket(9)` は `A#00001`、
 * `amountBucket(10)` 〜 `amountBucket(99)` は `A#00002` のように、
 * **10 進の桁数**でバケット化する。桁数バケットにすることで:
 * - 任意の範囲 `[min, max]` を覆うバケット数は最大 16 個（高々 16 桁）に収まる。
 * - 同じ桁の金額は同じパーティションに入るため、バケット内の絞り込みは
 *   `sk`（16 桁金額文字列）の範囲指定で行える。
 *
 * @throws ValidationError 負数・非整数・安全整数でない値の場合
 */
export function amountBucket(amountYen: number): string {
  assertAmountYen(amountYen);
  return bucketForDigits(decimalDigits(amountYen));
}

/**
 * 金額範囲 `[min, max]` を覆うバケットパーティション（桁クラス）の一覧を返す。
 *
 * 片側のみの指定は「下限なし = 0 円」「上限なし = `MAX_AMOUNT_YEN`」として扱う。
 * 戻り値は金額の昇順（＝辞書順）で並び、最大 16 個である。
 * 金額のみの検索は、この一覧の数だけ索引アクセスすればよい。
 *
 * @throws ValidationError 金額が不正、または `min > max` の場合
 */
export function amountBucketsCovering(
  min: number | undefined,
  max: number | undefined,
): readonly string[] {
  const lower = min ?? 0;
  const upper = max ?? MAX_AMOUNT_YEN;
  assertAmountYen(lower);
  assertAmountYen(upper);
  if (lower > upper) {
    throw new ValidationError(`金額範囲が逆転しています（min: ${lower} / max: ${upper}）`);
  }
  const buckets: string[] = [];
  for (let digits = decimalDigits(lower); digits <= decimalDigits(upper); digits += 1) {
    buckets.push(bucketForDigits(digits));
  }
  return buckets;
}

/** 桁数に対応する金額バケットを組み立てる。 */
function bucketForDigits(digits: number): string {
  return `${AMOUNT_BUCKET_PREFIX}${String(digits).padStart(AMOUNT_BUCKET_WIDTH, '0')}`;
}

/** 0 以上の整数の 10 進桁数（0 は 1 桁として扱う）。 */
function decimalDigits(amountYen: number): number {
  return String(amountYen).length;
}

/** 金額として妥当か検証する（0 以上の安全整数のみ許可）。 */
function assertAmountYen(amountYen: number): void {
  if (!Number.isSafeInteger(amountYen)) {
    throw new ValidationError(
      `金額は 0 以上の安全な整数（円）で指定してください: ${String(amountYen)}`,
    );
  }
  if (amountYen < 0) {
    throw new ValidationError(`金額に負数は指定できません: ${amountYen}`);
  }
}

// ---------------------------------------------------------------------------
// 日付・取引先のパーティション
// ---------------------------------------------------------------------------

/**
 * 日付の月パーティションを返す（例: `2026-10-15` → `D#2026-10`）。
 *
 * 日付の範囲検索は、この月パーティションを範囲内の月数だけ列挙することで、
 * 1 回の索引アクセスでは表現できない範囲条件を漏れなく実行できる。
 *
 * @throws ValidationError 実在しない日付、または `YYYY-MM-DD` 形式でない場合
 */
export function datePartition(isoDate: IsoDate): string {
  if (!isValidIsoDate(isoDate)) {
    throw new ValidationError(`取引年月日が不正です（YYYY-MM-DD 形式の実在する日付を指定）: ${isoDate}`);
  }
  return `${DATE_PARTITION_PREFIX}${isoDate.slice(0, 7)}`;
}

/**
 * 正規化済み取引先名のパーティションを返す（`C#<正規化名>`）。
 *
 * @throws ValidationError 正規化後が空文字の場合
 */
export function counterpartyPartition(normalized: string): string {
  if (normalized.length === 0) {
    throw new ValidationError('正規化後の取引先名が空です');
  }
  return `${COUNTERPARTY_PARTITION_PREFIX}${normalized}`;
}

// ---------------------------------------------------------------------------
// レコードと索引エントリ
// ---------------------------------------------------------------------------

/**
 * 証憑から索引レコードを組み立てる。
 *
 * 取引先名は `normalizeCounterparty` で正規化してから保持する
 * （正規化済みの値を渡しても結果は変わらない＝冪等）。
 *
 * @throws ValidationError ID が空、日付・金額・連番が不正、取引先名が空などの場合
 */
export function toIndexRecord(v: {
  readonly voucherId: string;
  readonly transactionDate: IsoDate;
  readonly amountYen: number;
  readonly counterpartyNormalized: string;
  readonly documentType: DocumentType;
  readonly sequence: number;
}): IndexRecord {
  if (v.voucherId.trim().length === 0) {
    throw new ValidationError('証憑 ID が空です');
  }
  if (!isValidIsoDate(v.transactionDate)) {
    throw new ValidationError(
      `取引年月日が不正です（YYYY-MM-DD 形式の実在する日付を指定）: ${v.transactionDate}`,
    );
  }
  assertAmountYen(v.amountYen);
  if (!Number.isInteger(v.sequence) || v.sequence < 1) {
    throw new ValidationError(`台帳の連番は 1 以上の整数で指定してください: ${String(v.sequence)}`);
  }
  const normalized = normalizeCounterparty(v.counterpartyNormalized);
  if (normalized.length === 0) {
    throw new ValidationError('取引先名が空です（正規化後に空文字になりました）');
  }
  return {
    voucherId: v.voucherId,
    transactionDate: v.transactionDate,
    amountYen: v.amountYen,
    counterpartyNormalized: normalized,
    documentType: v.documentType,
    sequence: v.sequence,
  };
}

/**
 * 索引レコードから 5 本の索引エントリを導出する。
 *
 * キー設計（`pk` / `sk`）:
 * | 索引 | pk | sk |
 * |---|---|---|
 * | by-date | `D#yyyy-mm` | `<date>#<amountPadded>#<voucherId>` |
 * | by-amount | `A#<桁数 5 桁>` | `<amountPadded>#<voucherId>` |
 * | by-counterparty | `C#<正規化名>` | `<date>#<voucherId>` |
 * | by-counterparty-date | `C#<正規化名>#D#yyyy-mm` | `<date>#<voucherId>` |
 * | by-counterparty-amount | `C#<正規化名>#A#<桁数>` | `<amountPadded>#<voucherId>` |
 *
 * 戻り値は `INDEX_NAMES` と同じ順序で必ず 5 件。`record` は正規化済みの複製を持つ。
 *
 * @throws ValidationError レコードの内容が不正な場合
 */
export function deriveIndexEntries(record: IndexRecord): readonly IndexEntry[] {
  const normalized = normalizeCounterparty(record.counterpartyNormalized);
  const normalizedRecord: IndexRecord = { ...record, counterpartyNormalized: normalized };
  const voucherId = normalizedRecord.voucherId;
  if (voucherId.trim().length === 0) {
    throw new ValidationError('証憑 ID が空です');
  }
  if (!Number.isInteger(normalizedRecord.sequence) || normalizedRecord.sequence < 1) {
    throw new ValidationError(
      `台帳の連番は 1 以上の整数で指定してください: ${String(normalizedRecord.sequence)}`,
    );
  }

  const date = normalizedRecord.transactionDate;
  const amountPadded = encodeAmount(normalizedRecord.amountYen);
  const dateKey = datePartition(date);
  const counterpartyKey = counterpartyPartition(normalized);
  const amountKey = amountBucket(normalizedRecord.amountYen);

  return [
    {
      index: 'by-date',
      partitionKey: dateKey,
      sortKey: `${date}#${amountPadded}#${voucherId}`,
      record: normalizedRecord,
    },
    {
      index: 'by-amount',
      partitionKey: amountKey,
      sortKey: `${amountPadded}#${voucherId}`,
      record: normalizedRecord,
    },
    {
      index: 'by-counterparty',
      partitionKey: counterpartyKey,
      sortKey: `${date}#${voucherId}`,
      record: normalizedRecord,
    },
    {
      index: 'by-counterparty-date',
      partitionKey: `${counterpartyKey}#${dateKey}`,
      sortKey: `${date}#${voucherId}`,
      record: normalizedRecord,
    },
    {
      index: 'by-counterparty-amount',
      partitionKey: `${counterpartyKey}#${amountKey}`,
      sortKey: `${amountPadded}#${voucherId}`,
      record: normalizedRecord,
    },
  ];
}
