/**
 * 検索の検証・計画・実行と、検索要件の充足を示すテスト。
 *
 * 検索要件（①取引年月日 ②取引金額 ③取引先 / 範囲指定 / 2 項目以上の組み合わせ）を
 * 「宣言」ではなく「実測」で示す。すなわち:
 * - `describeSearchCapability` が 3 項目・範囲・3 通りの 2 項目組み合わせを返すこと
 * - それらが本当に計画できること（`planQuery` が索引アクセスを組み立てる）
 * - 実際に `LocalIndexStore` へデータを投入し、`executeQuery` が正しい集合を
 *   返すこと（組み合わせ検索の結果が各条件の積集合になること）
 * の 3 点をテストで固定する。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  DocumentType,
  IndexQuery,
  IndexRecord,
  QueryPlan,
  SearchField,
  VoucherQuery,
} from '../../src/core/types.js';
import { ValidationError } from '../../src/core/errors.js';
import {
  INDEX_NAMES,
  deriveIndexEntries,
  encodeAmount,
  toIndexRecord,
} from '../../src/core/index-keys.js';
import {
  MAX_MONTH_ACCESSES,
  TWO_FIELD_COMBINATIONS,
  describeSearchCapability,
  executeQuery,
  matchesResidual,
  planQuery,
  validateQuery,
} from '../../src/core/query.js';
import { LocalIndexStore } from '../../src/adapters/local/index-store.js';

// ---------------------------------------------------------------------------
// 検索対象のシードデータ
// ---------------------------------------------------------------------------

/** テスト用の証憑 1 件分（取り込み済みのメタデータ相当）。 */
interface SeedVoucher {
  readonly voucherId: string;
  readonly transactionDate: string;
  readonly amountYen: number;
  readonly counterparty: string;
  readonly documentType: DocumentType;
  readonly sequence: number;
}

/**
 * 同じ取引先が表記揺れで登録されているケースを含むシード。
 * 「株式会社サンプル商事」「サンプル商事(株)」「㈱サンプル商事」は
 * 正規化するとすべて同じ取引先として検索できる必要がある。
 */
const SEED: readonly SeedVoucher[] = [
  { voucherId: 'v-001', transactionDate: '2026-01-05', amountYen: 1_200, counterparty: '株式会社サンプル商事', documentType: 'invoice', sequence: 1 },
  { voucherId: 'v-002', transactionDate: '2026-01-20', amountYen: 980_000, counterparty: '有限会社テスト工業', documentType: 'invoice', sequence: 2 },
  { voucherId: 'v-003', transactionDate: '2026-02-10', amountYen: 0, counterparty: 'サンプル商事(株)', documentType: 'invoice', sequence: 3 },
  { voucherId: 'v-004', transactionDate: '2026-02-28', amountYen: 13_500, counterparty: '株式会社サンプル商事', documentType: 'receipt', sequence: 4 },
  { voucherId: 'v-005', transactionDate: '2026-03-15', amountYen: 999_999_999_999, counterparty: 'テスト工業(有)', documentType: 'contract', sequence: 5 },
  { voucherId: 'v-006', transactionDate: '2025-12-31', amountYen: 5_000, counterparty: '㈱サンプル商事', documentType: 'order', sequence: 6 },
  { voucherId: 'v-007', transactionDate: '2026-10-01', amountYen: 42, counterparty: 'その他商店', documentType: 'other', sequence: 7 },
  { voucherId: 'v-008', transactionDate: '2026-03-15', amountYen: 100, counterparty: 'テスト工業(有)', documentType: 'invoice', sequence: 8 },
];

let tempDir = '';
let store: LocalIndexStore;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'dencho-query-'));
  store = new LocalIndexStore(join(tempDir, 'index.json'));
  const entries = SEED.flatMap((seed) =>
    deriveIndexEntries(
      toIndexRecord({
        voucherId: seed.voucherId,
        transactionDate: seed.transactionDate,
        amountYen: seed.amountYen,
        counterpartyNormalized: seed.counterparty,
        documentType: seed.documentType,
        sequence: seed.sequence,
      }),
    ),
  );
  await store.rebuild(entries);
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

/** 検索条件から計画を立てて実行する（通常の利用経路）。 */
async function run(query: VoucherQuery): Promise<readonly IndexRecord[]> {
  return executeQuery(query, planQuery(query), store);
}

/** 結果から証憑 ID だけを取り出す。 */
function ids(records: readonly IndexRecord[]): readonly string[] {
  return records.map((record) => record.voucherId);
}

/** 計画の先頭アクセスを取り出す（テスト用の番人付き）。 */
function firstAccess(plan: QueryPlan): IndexQuery {
  const access = plan.accesses[0];
  if (access === undefined) {
    throw new Error('索引アクセスが 1 つもありません');
  }
  return access;
}

/** 指定した日付範囲内の全証憑（既定の並び）を返す条件。 */
const ALL_QUERY: VoucherQuery = { dateFrom: '2025-01-01', dateTo: '2026-12-31' };

// ---------------------------------------------------------------------------
// validateQuery
// ---------------------------------------------------------------------------

describe('validateQuery', () => {
  it('検索条件が 1 つも無い場合は拒否する', () => {
    expect(() => validateQuery({})).toThrow(ValidationError);
    expect(() => validateQuery({})).toThrow(/検索条件/);
  });

  it('limit / order だけでは検索条件と見なさない', () => {
    expect(() => validateQuery({ limit: 10 })).toThrow(ValidationError);
    expect(() => validateQuery({ order: 'date-asc' })).toThrow(ValidationError);
  });

  it('日付範囲の逆転を拒否する', () => {
    expect(() => validateQuery({ dateFrom: '2026-02-01', dateTo: '2026-01-01' })).toThrow(
      ValidationError,
    );
  });

  it('実在しない日付・形式違いの日付を拒否する', () => {
    expect(() => validateQuery({ dateFrom: '2026-02-30' })).toThrow(ValidationError);
    expect(() => validateQuery({ dateTo: '2026-1-1' })).toThrow(ValidationError);
  });

  it('金額範囲の逆転・負数・小数を拒否する', () => {
    expect(() => validateQuery({ amountMin: 100, amountMax: 10 })).toThrow(ValidationError);
    expect(() => validateQuery({ amountMin: -1 })).toThrow(ValidationError);
    expect(() => validateQuery({ amountMax: 1.5 })).toThrow(ValidationError);
  });

  it('正規化すると空になる取引先名を拒否する', () => {
    expect(() => validateQuery({ counterparty: '株式会社' })).toThrow(ValidationError);
    expect(() => validateQuery({ counterparty: '　' })).toThrow(ValidationError);
  });

  it('妥当な条件は受け入れる', () => {
    const validQueries: readonly VoucherQuery[] = [
      { counterparty: 'サンプル商事' },
      { dateFrom: '2026-01-01' },
      { dateTo: '2026-01-31' },
      { amountMin: 0, amountMax: 9_999 },
      { dateFrom: '2026-01-01', dateTo: '2026-01-31', amountMin: 0, counterparty: 'サンプル商事' },
      { documentType: 'invoice' },
    ];
    for (const query of validQueries) {
      expect(() => validateQuery(query)).not.toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// 検索計画（決定表の固定）
// ---------------------------------------------------------------------------

describe('planQuery（索引の選択）', () => {
  it('取引先 + 日付（両端指定）は by-counterparty-date を月数分引く', () => {
    const plan = planQuery({
      counterparty: '株式会社サンプル商事',
      dateFrom: '2026-01-01',
      dateTo: '2026-03-31',
    });
    expect(plan.accesses.map((access) => access.index)).toEqual([
      'by-counterparty-date',
      'by-counterparty-date',
      'by-counterparty-date',
    ]);
    expect(plan.accesses.map((access) => access.partitionKey)).toEqual([
      'C#サンプル商事#D#2026-01',
      'C#サンプル商事#D#2026-02',
      'C#サンプル商事#D#2026-03',
    ]);
    expect(plan.estimatedAccesses).toBe(3);
    // 最初の月は dateFrom 以降、最後の月は dateTo 以前にソートキーを絞る。
    expect(firstAccess(plan).sortKeyFrom).toBe('2026-01-01#');
    expect(plan.accesses[2]?.sortKeyTo?.startsWith('2026-03-31#')).toBe(true);
    expect(plan.rationale).toContain('by-counterparty-date');
    expect(plan.rationale.length).toBeGreaterThan(20);
  });

  it('取引先 + 日付（片側のみ）は by-counterparty 1 アクセスで日付をソートキー範囲にする', () => {
    const plan = planQuery({ counterparty: 'サンプル商事', dateFrom: '2026-01-01' });
    expect(plan.accesses).toHaveLength(1);
    expect(firstAccess(plan).index).toBe('by-counterparty');
    expect(firstAccess(plan).partitionKey).toBe('C#サンプル商事');
    expect(firstAccess(plan).sortKeyFrom).toBe('2026-01-01#');
    expect(firstAccess(plan).sortKeyTo).toBeUndefined();
    expect(plan.estimatedAccesses).toBe(1);
    expect(plan.rationale).toContain('by-counterparty');
  });

  it('取引先 + 金額は by-counterparty-amount を金額バケット数分引く', () => {
    const plan = planQuery({ counterparty: 'サンプル商事', amountMin: 0, amountMax: 9_999 });
    expect(plan.accesses.map((access) => access.index)).toEqual([
      'by-counterparty-amount',
      'by-counterparty-amount',
      'by-counterparty-amount',
      'by-counterparty-amount',
    ]);
    expect(plan.accesses.map((access) => access.partitionKey)).toEqual([
      'C#サンプル商事#A#00001',
      'C#サンプル商事#A#00002',
      'C#サンプル商事#A#00003',
      'C#サンプル商事#A#00004',
    ]);
    expect(firstAccess(plan).sortKeyFrom).toBe(`${encodeAmount(0)}#`);
    expect(plan.rationale).toContain('by-counterparty-amount');
  });

  it('取引先のみは by-counterparty 1 アクセス', () => {
    const plan = planQuery({ counterparty: 'サンプル商事' });
    expect(plan.accesses).toHaveLength(1);
    expect(firstAccess(plan).index).toBe('by-counterparty');
    expect(firstAccess(plan).sortKeyFrom).toBeUndefined();
    expect(firstAccess(plan).sortKeyTo).toBeUndefined();
    expect(plan.estimatedAccesses).toBe(1);
  });

  it('日付のみ（両端指定）は by-date を月数分引く', () => {
    const plan = planQuery({ dateFrom: '2026-01-01', dateTo: '2026-03-31' });
    expect(plan.accesses.map((access) => access.index)).toEqual(['by-date', 'by-date', 'by-date']);
    expect(plan.accesses.map((access) => access.partitionKey)).toEqual([
      'D#2026-01',
      'D#2026-02',
      'D#2026-03',
    ]);
    expect(plan.estimatedAccesses).toBe(3);
    expect(plan.rationale).toContain('by-date');
  });

  it('日付のみ（片側指定）は最大 120 か月（10 年）分へ展開する', () => {
    expect(MAX_MONTH_ACCESSES).toBe(120);
    const fromOnly = planQuery({ dateFrom: '2026-01-01' });
    expect(fromOnly.accesses).toHaveLength(MAX_MONTH_ACCESSES);
    expect(firstAccess(fromOnly).partitionKey).toBe('D#2026-01');
    expect(fromOnly.accesses[fromOnly.accesses.length - 1]?.partitionKey).toBe('D#2035-12');

    const toOnly = planQuery({ dateTo: '2026-03-31' });
    expect(toOnly.accesses).toHaveLength(MAX_MONTH_ACCESSES);
    expect(firstAccess(toOnly).partitionKey).toBe('D#2016-04');
    expect(toOnly.accesses[toOnly.accesses.length - 1]?.partitionKey).toBe('D#2026-03');
    expect(toOnly.rationale).toContain('10 年');
  });

  it('日付 + 金額は by-date で日付を絞り、金額を残条件にする', () => {
    const plan = planQuery({
      dateFrom: '2026-01-01',
      dateTo: '2026-03-31',
      amountMin: 0,
      amountMax: 2_000,
    });
    expect(plan.accesses.map((access) => access.index)).toEqual(['by-date', 'by-date', 'by-date']);
    expect(plan.residual.amountMin).toBe(0);
    expect(plan.residual.amountMax).toBe(2_000);
    expect(plan.rationale).toContain('残条件');
  });

  it('金額のみは by-amount を金額バケット数分引く', () => {
    const plan = planQuery({ amountMin: 0, amountMax: 9_999 });
    expect(plan.accesses.map((access) => access.index)).toEqual([
      'by-amount',
      'by-amount',
      'by-amount',
      'by-amount',
    ]);
    expect(plan.accesses.map((access) => access.partitionKey)).toEqual([
      'A#00001',
      'A#00002',
      'A#00003',
      'A#00004',
    ]);
    expect(firstAccess(plan).sortKeyFrom).toBe(`${encodeAmount(0)}#`);
    expect(firstAccess(plan).sortKeyTo?.startsWith(`${encodeAmount(9_999)}#`)).toBe(true);
    expect(plan.rationale).toContain('by-amount');
  });

  it('金額の上限のみ指定でも桁クラス分だけ引く', () => {
    const plan = planQuery({ amountMax: 100 });
    expect(plan.accesses.map((access) => access.partitionKey)).toEqual([
      'A#00001',
      'A#00002',
      'A#00003',
    ]);
  });

  it('取引先 + 日付 + 金額は複合索引で日付を絞り金額を残条件にする', () => {
    const plan = planQuery({
      counterparty: 'サンプル商事',
      dateFrom: '2026-01-01',
      dateTo: '2026-02-28',
      amountMin: 0,
      amountMax: 2_000,
    });
    expect(plan.accesses.every((access) => access.index === 'by-counterparty-date')).toBe(true);
    expect(plan.accesses).toHaveLength(2);
    expect(plan.residual.amountMin).toBe(0);
    expect(plan.residual.amountMax).toBe(2_000);
  });

  it('書類種別は常に残条件になる', () => {
    const plan = planQuery({ dateFrom: '2026-01-01', dateTo: '2026-01-31', documentType: 'receipt' });
    expect(plan.residual.documentType).toBe('receipt');
    expect(plan.rationale).toContain('書類種別');
  });

  it('日付範囲が 120 か月を超える日付のみ検索は拒否する', () => {
    expect(() => planQuery({ dateFrom: '2015-01-01', dateTo: '2026-01-01' })).toThrow(
      ValidationError,
    );
    expect(() => planQuery({ dateFrom: '2015-01-01', dateTo: '2026-01-01' })).toThrow(/広すぎます/);
  });

  it('日付範囲が広くても取引先があれば by-counterparty 1 アクセスへ切り替える', () => {
    const plan = planQuery({
      counterparty: 'サンプル商事',
      dateFrom: '2015-01-01',
      dateTo: '2026-01-01',
    });
    expect(plan.accesses).toHaveLength(1);
    expect(firstAccess(plan).index).toBe('by-counterparty');
    expect(firstAccess(plan).sortKeyFrom).toBe('2015-01-01#');
  });

  it('書類種別のみは by-amount の全バケット走査 + 残条件で計画できる', () => {
    const plan = planQuery({ documentType: 'invoice' });
    expect(plan.accesses).toHaveLength(16);
    expect(plan.accesses.every((access) => access.index === 'by-amount')).toBe(true);
    expect(plan.accesses[0]?.partitionKey).toBe('A#00001');
    expect(plan.accesses[15]?.partitionKey).toBe('A#00016');
    expect(plan.residual.documentType).toBe('invoice');
    expect(plan.rationale).toContain('by-amount');
  });

  it('計画は必ず検索条件を検証してから作る', () => {
    expect(() => planQuery({})).toThrow(ValidationError);
    expect(() => planQuery({ dateFrom: '2026-02-01', dateTo: '2026-01-01' })).toThrow(
      ValidationError,
    );
  });
});

// ---------------------------------------------------------------------------
// 残条件の判定
// ---------------------------------------------------------------------------

describe('matchesResidual', () => {
  const record = toIndexRecord({
    voucherId: 'v-100',
    transactionDate: '2026-10-15',
    amountYen: 12_345,
    counterpartyNormalized: '株式会社サンプル商事',
    documentType: 'invoice',
    sequence: 100,
  });

  it('残条件が空なら常に一致する', () => {
    expect(matchesResidual(record, {})).toBe(true);
  });

  it('日付範囲（両端含む）を判定する', () => {
    expect(matchesResidual(record, { dateFrom: '2026-10-15', dateTo: '2026-10-15' })).toBe(true);
    expect(matchesResidual(record, { dateFrom: '2026-10-16' })).toBe(false);
    expect(matchesResidual(record, { dateTo: '2026-10-14' })).toBe(false);
  });

  it('金額範囲（両端含む）を判定する', () => {
    expect(matchesResidual(record, { amountMin: 12_345, amountMax: 12_345 })).toBe(true);
    expect(matchesResidual(record, { amountMin: 12_346 })).toBe(false);
    expect(matchesResidual(record, { amountMax: 12_344 })).toBe(false);
  });

  it('取引先は正規化して比較する', () => {
    expect(matchesResidual(record, { counterparty: '㈱サンプル商事' })).toBe(true);
    expect(matchesResidual(record, { counterparty: 'サンプル商事(株)' })).toBe(true);
    expect(matchesResidual(record, { counterparty: '別会社' })).toBe(false);
  });

  it('書類種別を判定する', () => {
    expect(matchesResidual(record, { documentType: 'invoice' })).toBe(true);
    expect(matchesResidual(record, { documentType: 'receipt' })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// executeQuery（実データでの実行）
// ---------------------------------------------------------------------------

describe('executeQuery', () => {
  it('既定は取引年月日の降順（同日は台帳の新しい順）', async () => {
    expect(ids(await run(ALL_QUERY))).toEqual([
      'v-007', // 2026-10-01
      'v-008', // 2026-03-15（同日は sequence 8 > 5）
      'v-005',
      'v-004', // 2026-02-28
      'v-003', // 2026-02-10
      'v-002', // 2026-01-20
      'v-001', // 2026-01-05
      'v-006', // 2025-12-31
    ]);
  });

  it('date-asc は昇順（同日は台帳の古い順）', async () => {
    expect(ids(await run({ ...ALL_QUERY, order: 'date-asc' }))).toEqual([
      'v-006',
      'v-001',
      'v-002',
      'v-003',
      'v-004',
      'v-005',
      'v-008',
      'v-007',
    ]);
  });

  it('amount-desc は金額の降順', async () => {
    expect(ids(await run({ ...ALL_QUERY, order: 'amount-desc' }))).toEqual([
      'v-005', // 999,999,999,999
      'v-002', // 980,000
      'v-004', // 13,500
      'v-006', // 5,000
      'v-001', // 1,200
      'v-008', // 100
      'v-007', // 42
      'v-003', // 0
    ]);
  });

  it('limit は整列後に適用する（0 や負数は 0 件、NaN は指定なし）', async () => {
    expect(ids(await run({ ...ALL_QUERY, limit: 2 }))).toEqual(['v-007', 'v-008']);
    expect(await run({ ...ALL_QUERY, limit: 0 })).toHaveLength(0);
    expect(await run({ ...ALL_QUERY, limit: -5 })).toHaveLength(0);
    expect(await run({ ...ALL_QUERY, limit: Number.NaN })).toHaveLength(SEED.length);
  });

  it('同じ索引アクセスが重複しても voucherId で重複排除する', async () => {
    const access: IndexQuery = { index: 'by-counterparty', partitionKey: 'C#サンプル商事' };
    const plan: QueryPlan = {
      accesses: [access, access],
      residual: {},
      estimatedAccesses: 2,
      rationale: '重複排除の検証用',
    };
    const records = await executeQuery({ counterparty: 'サンプル商事' }, plan, store);
    expect(ids(records)).toEqual(['v-004', 'v-003', 'v-001', 'v-006']);
  });
});

// ---------------------------------------------------------------------------
// 検索要件の証明（実測）
// ---------------------------------------------------------------------------

describe('検索要件: 3 項目・範囲・組み合わせ', () => {
  it('取引年月日の範囲検索ができる', async () => {
    expect(ids(await run({ dateFrom: '2026-02-01', dateTo: '2026-02-28' }))).toEqual([
      'v-004',
      'v-003',
    ]);
    expect(ids(await run({ dateFrom: '2026-02-10', dateTo: '2026-02-28' }))).toEqual([
      'v-004',
      'v-003',
    ]);
    expect(ids(await run({ dateTo: '2026-01-31' }))).toEqual(['v-002', 'v-001', 'v-006']);
  });

  it('取引金額の範囲検索ができる（境界を含む）', async () => {
    expect(ids(await run({ amountMin: 10_000, amountMax: 20_000 }))).toEqual(['v-004']);
    expect(ids(await run({ amountMin: 0, amountMax: 42 }))).toEqual(['v-007', 'v-003']);
    expect(ids(await run({ amountMin: 999_999_999_999 }))).toEqual(['v-005']);
  });

  it('取引先の検索ができる（表記揺れを同一視）', async () => {
    // 2025-12-31 の v-006 も同じ取引先（表記は ㈱サンプル商事）なので含まれる。
    const expected = ['v-004', 'v-003', 'v-001', 'v-006'];
    expect(ids(await run({ counterparty: '株式会社サンプル商事' }))).toEqual(expected);
    expect(ids(await run({ counterparty: 'サンプル商事(株)' }))).toEqual(expected);
    expect(ids(await run({ counterparty: '㈱サンプル商事' }))).toEqual(expected);
    expect(ids(await run({ counterparty: 'テスト工業' }))).toEqual(['v-008', 'v-005', 'v-002']);
  });

  it('日付 + 金額の組み合わせ検索ができる', async () => {
    const records = await run({
      dateFrom: '2026-01-01',
      dateTo: '2026-02-28',
      amountMin: 0,
      amountMax: 2_000,
    });
    expect(ids(records)).toEqual(['v-003', 'v-001']);
  });

  it('日付 + 取引先の組み合わせ検索ができる', async () => {
    const records = await run({
      dateFrom: '2026-01-01',
      dateTo: '2026-03-31',
      counterparty: 'サンプル商事',
    });
    expect(ids(records)).toEqual(['v-004', 'v-003', 'v-001']);
  });

  it('金額 + 取引先の組み合わせ検索ができる', async () => {
    const records = await run({ amountMin: 0, amountMax: 20_000, counterparty: 'サンプル商事' });
    expect(ids(records)).toEqual(['v-004', 'v-003', 'v-001', 'v-006']);
  });

  it('3 項目すべての組み合わせ検索ができる（結果は各条件の積集合）', async () => {
    const records = await run({
      dateFrom: '2026-01-01',
      dateTo: '2026-02-28',
      amountMin: 0,
      amountMax: 2_000,
      counterparty: 'サンプル商事',
    });
    expect(ids(records)).toEqual(['v-003', 'v-001']);
  });

  it('書類種別の残条件が効く（日付のみ + 書類種別）', async () => {
    const records = await run({
      dateFrom: '2025-01-01',
      dateTo: '2026-12-31',
      documentType: 'receipt',
    });
    expect(ids(records)).toEqual(['v-004']);
  });

  it('書類種別の残条件が効く（金額のみ + 書類種別）', async () => {
    const records = await run({ amountMin: 0, amountMax: 1_000_000, documentType: 'invoice' });
    expect(ids(records)).toEqual(['v-008', 'v-003', 'v-002', 'v-001']);
  });

  it('書類種別だけでも検索できる（索引が無い項目は有界の全バケット走査 + 残条件）', async () => {
    expect(ids(await run({ documentType: 'receipt' }))).toEqual(['v-004']);
    expect(ids(await run({ documentType: 'contract' }))).toEqual(['v-005']);
    expect(ids(await run({ documentType: 'invoice' }))).toEqual(['v-008', 'v-003', 'v-002', 'v-001']);
  });

  it('date-only の片側指定でも期限後の証憑を取りこぼさない（保存期間 7 年内）', async () => {
    // dateFrom のみの指定は 120 か月分展開するため、2026 年の全証憑が対象になる。
    const records = await run({ dateFrom: '2026-01-01' });
    expect(ids(records)).toEqual(['v-007', 'v-008', 'v-005', 'v-004', 'v-003', 'v-002', 'v-001']);
  });
});

// ---------------------------------------------------------------------------
// describeSearchCapability（監査への証跡）
// ---------------------------------------------------------------------------

describe('describeSearchCapability', () => {
  it('検索要件の 3 項目・範囲・2 項目組み合わせ・出力形式・索引を返す', () => {
    expect(describeSearchCapability()).toEqual({
      searchableFields: ['transactionDate', 'amount', 'counterparty'],
      supportsDateRange: true,
      supportsAmountRange: true,
      supportsCounterparty: true,
      twoFieldCombinations: [
        'transactionDate+amount',
        'transactionDate+counterparty',
        'amount+counterparty',
      ],
      exportFormats: ['csv', 'json'],
      indexes: [...INDEX_NAMES],
    });
  });

  it('2 項目組み合わせの一覧は計画器の証明用クエリと一致する', () => {
    expect(TWO_FIELD_COMBINATIONS).toEqual(describeSearchCapability().twoFieldCombinations);
    expect(TWO_FIELD_COMBINATIONS).toHaveLength(3);
  });

  it('公開した組み合わせは実際に計画できる（宣言と実装が一致する）', () => {
    const probes: Readonly<Record<string, { readonly query: VoucherQuery; readonly index: string }>> = {
      'transactionDate+amount': {
        query: { dateFrom: '2026-01-01', dateTo: '2026-01-31', amountMin: 0, amountMax: 9_999 },
        index: 'by-date',
      },
      'transactionDate+counterparty': {
        query: { dateFrom: '2026-01-01', dateTo: '2026-01-31', counterparty: 'サンプル商事' },
        index: 'by-counterparty-date',
      },
      'amount+counterparty': {
        query: { amountMin: 0, amountMax: 9_999, counterparty: 'サンプル商事' },
        index: 'by-counterparty-amount',
      },
    };
    for (const combination of describeSearchCapability().twoFieldCombinations) {
      const probe = probes[combination];
      if (probe === undefined) {
        throw new Error(`未知の組み合わせです: ${combination}`);
      }
      const plan = planQuery(probe.query);
      expect(plan.accesses.length).toBeGreaterThan(0);
      expect(firstAccess(plan).index).toBe(probe.index);
    }
  });

  it('公開した検索項目は実際に検索でき、全件より少ない集合を返す', async () => {
    const capability = describeSearchCapability();
    const fieldQueries: Readonly<Record<SearchField, VoucherQuery>> = {
      transactionDate: { dateFrom: '2026-02-01', dateTo: '2026-02-28' },
      amount: { amountMin: 0, amountMax: 5_000 },
      counterparty: { counterparty: 'サンプル商事' },
    };
    for (const field of capability.searchableFields) {
      const query = fieldQueries[field];
      const records = await run(query);
      expect(records.length).toBeGreaterThan(0);
      expect(records.length).toBeLessThan(SEED.length);
    }
  });

  it('範囲指定の公開値は実際の計画と一致する', () => {
    const capability = describeSearchCapability();
    expect(capability.supportsDateRange).toBe(planQuery({ dateFrom: '2026-01-01', dateTo: '2026-01-31' }).accesses.length > 0);
    expect(capability.supportsAmountRange).toBe(planQuery({ amountMin: 0, amountMax: 100 }).accesses.length > 0);
    expect(capability.supportsCounterparty).toBe(planQuery({ counterparty: 'サンプル商事' }).accesses.length > 0);
  });
});
