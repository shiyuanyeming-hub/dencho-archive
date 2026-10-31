/**
 * 索引キー設計のテスト（検索要件の土台）。
 *
 * ここで固定するのは「実装の写経」ではなく、検索要件を満たすために
 * 必要な**キーの性質**である:
 * - 金額のエンコード順 = 数値順（範囲検索がソートキーで表現できる根拠）
 * - 取引先の正規化（表記揺れがあっても同じ取引先を引ける根拠）
 * - 5 本の索引が単一のレコードから必ず導出されること
 */

import { describe, expect, it } from 'vitest';

import type { DocumentType, IndexRecord } from '../../src/core/types.js';
import { ValidationError } from '../../src/core/errors.js';
import {
  AMOUNT_ENCODING_WIDTH,
  INDEX_NAMES,
  MAX_AMOUNT_YEN,
  amountBucket,
  amountBucketsCovering,
  counterpartyPartition,
  datePartition,
  decodeAmount,
  deriveIndexEntries,
  encodeAmount,
  normalizeCounterparty,
  toIndexRecord,
} from '../../src/core/index-keys.js';

/** テスト用の索引レコードを作る（既定値は「株式会社サンプル商事の請求書」）。 */
function fixture(
  overrides: {
    readonly voucherId?: string;
    readonly transactionDate?: string;
    readonly amountYen?: number;
    readonly counterpartyNormalized?: string;
    readonly documentType?: DocumentType;
    readonly sequence?: number;
  } = {},
): IndexRecord {
  return toIndexRecord({
    voucherId: overrides.voucherId ?? 'v-001',
    transactionDate: overrides.transactionDate ?? '2026-10-15',
    amountYen: overrides.amountYen ?? 12_345,
    counterpartyNormalized: overrides.counterpartyNormalized ?? '株式会社サンプル商事',
    documentType: overrides.documentType ?? 'invoice',
    sequence: overrides.sequence ?? 1,
  });
}

describe('INDEX_NAMES', () => {
  it('5 本の索引を単独 3 本 + 複合 2 本の順で持つ', () => {
    expect(INDEX_NAMES).toEqual([
      'by-date',
      'by-amount',
      'by-counterparty',
      'by-counterparty-date',
      'by-counterparty-amount',
    ]);
    expect(new Set(INDEX_NAMES).size).toBe(5);
  });
});

describe('encodeAmount / decodeAmount', () => {
  it('16 桁の固定幅ゼロ埋め文字列になる', () => {
    expect(AMOUNT_ENCODING_WIDTH).toBe(16);
    expect(encodeAmount(0)).toBe('0000000000000000');
    expect(encodeAmount(9)).toBe('0000000000000009');
    expect(encodeAmount(10)).toBe('0000000000000010');
    expect(encodeAmount(12_345)).toBe('0000000000012345');
    expect(encodeAmount(999_999_999_999)).toBe('0000999999999999');
    expect(encodeAmount(MAX_AMOUNT_YEN)).toBe('9007199254740991');
    for (const value of [0, 9, 10, 999_999_999_999]) {
      expect(encodeAmount(value)).toHaveLength(AMOUNT_ENCODING_WIDTH);
    }
  });

  it('境界値 0 / 9 / 10 / 999999999999 の辞書順が数値順と一致する', () => {
    const values = [0, 9, 10, 999_999_999_999];
    for (const left of values) {
      for (const right of values) {
        if (left < right) {
          expect(encodeAmount(left) < encodeAmount(right)).toBe(true);
        }
        if (left === right) {
          expect(encodeAmount(left)).toBe(encodeAmount(right));
        }
      }
    }
  });

  it('広い値域で辞書順 = 数値順になる（範囲検索が成立する根拠）', () => {
    const values = [
      0, 1, 2, 9, 10, 11, 99, 100, 999, 1000, 9_999, 10_000, 999_999, 1_000_000,
      999_999_999_999, MAX_AMOUNT_YEN,
    ];
    for (const left of values) {
      for (const right of values) {
        if (left < right) {
          expect(encodeAmount(left) < encodeAmount(right)).toBe(true);
        }
      }
    }
  });

  it('decodeAmount はエンコードの逆変換になる', () => {
    for (const value of [0, 9, 10, 42, 12_345, 999_999_999_999, MAX_AMOUNT_YEN]) {
      expect(decodeAmount(encodeAmount(value))).toBe(value);
    }
  });

  it('負数・小数・安全整数でない金額を拒否する', () => {
    expect(() => encodeAmount(-1)).toThrow(ValidationError);
    expect(() => encodeAmount(1.5)).toThrow(ValidationError);
    expect(() => encodeAmount(Number.MAX_SAFE_INTEGER + 1)).toThrow(ValidationError);
    expect(() => encodeAmount(Number.NaN)).toThrow(ValidationError);
    expect(() => encodeAmount(Number.POSITIVE_INFINITY)).toThrow(ValidationError);
  });

  it('不正なエンコード値のデコードを拒否する', () => {
    expect(() => decodeAmount('abc')).toThrow(ValidationError);
    expect(() => decodeAmount('123')).toThrow(ValidationError);
    expect(() => decodeAmount('0000000000000010x')).toThrow(ValidationError);
  });
});

describe('normalizeCounterparty', () => {
  it('NFKC で全角英数字を半角へ寄せ、ASCII を小文字化する', () => {
    expect(normalizeCounterparty('ＡＢＣ商事')).toBe('abc商事');
    expect(normalizeCounterparty('ABC商事')).toBe('abc商事');
  });

  it('株式会社 / (株) / ㈱ の表記揺れを同一視する', () => {
    const canonical = normalizeCounterparty('株式会社サンプル商事');
    expect(canonical).toBe('サンプル商事');
    expect(normalizeCounterparty('サンプル商事(株)')).toBe(canonical);
    expect(normalizeCounterparty('サンプル商事（株）')).toBe(canonical);
    expect(normalizeCounterparty('㈱サンプル商事')).toBe(canonical);
    expect(normalizeCounterparty('(株)サンプル商事')).toBe(canonical);
  });

  it('有限会社 / (有) / ㈲ の表記揺れを同一視する', () => {
    const canonical = normalizeCounterparty('有限会社テスト工業');
    expect(canonical).toBe('テスト工業');
    expect(normalizeCounterparty('テスト工業(有)')).toBe(canonical);
    expect(normalizeCounterparty('㈲テスト工業')).toBe(canonical);
  });

  it('半角・全角スペースを含む空白をすべて除去する', () => {
    expect(normalizeCounterparty('  サンプル　商事  ')).toBe('サンプル商事');
    expect(normalizeCounterparty('サンプル\t商事\n')).toBe('サンプル商事');
  });

  it('冪等である（正規化済みの値をもう一度正規化しても変わらない）', () => {
    const samples = ['株式会社サンプル商事', 'サンプル商事(株)', 'ＡＢＣ商事', ' その他 商店 '];
    for (const sample of samples) {
      const once = normalizeCounterparty(sample);
      expect(normalizeCounterparty(once)).toBe(once);
    }
  });

  it('法人格だけの名前は空文字になる', () => {
    expect(normalizeCounterparty('株式会社')).toBe('');
    expect(normalizeCounterparty('(株)')).toBe('');
    expect(normalizeCounterparty('　')).toBe('');
  });
});

describe('datePartition', () => {
  it('取引年月日を月パーティションへ変換する', () => {
    expect(datePartition('2026-10-15')).toBe('D#2026-10');
    expect(datePartition('2026-01-01')).toBe('D#2026-01');
    expect(datePartition('2025-12-31')).toBe('D#2025-12');
  });

  it('実在しない日付・形式違いを拒否する', () => {
    expect(() => datePartition('2026-02-30')).toThrow(ValidationError);
    expect(() => datePartition('2026-1-1')).toThrow(ValidationError);
    expect(() => datePartition('20261015')).toThrow(ValidationError);
  });
});

describe('amountBucket / amountBucketsCovering', () => {
  it('10 進の桁数でバケット化する', () => {
    expect(amountBucket(0)).toBe('A#00001');
    expect(amountBucket(9)).toBe('A#00001');
    expect(amountBucket(10)).toBe('A#00002');
    expect(amountBucket(99)).toBe('A#00002');
    expect(amountBucket(100)).toBe('A#00003');
    expect(amountBucket(999_999_999_999)).toBe('A#00012');
    expect(amountBucket(MAX_AMOUNT_YEN)).toBe('A#00016');
  });

  it('範囲を覆うバケットを昇順で返す', () => {
    expect(amountBucketsCovering(0, 9_999)).toEqual([
      'A#00001',
      'A#00002',
      'A#00003',
      'A#00004',
    ]);
    expect(amountBucketsCovering(5, 5)).toEqual(['A#00001']);
    expect(amountBucketsCovering(10, 10)).toEqual(['A#00002']);
    expect(amountBucketsCovering(undefined, 100)).toEqual(['A#00001', 'A#00002', 'A#00003']);
    expect(amountBucketsCovering(100, undefined)).toHaveLength(14);
  });

  it('両側未指定なら全 16 バケット（高々 16 アクセスで金額検索できる）', () => {
    const buckets = amountBucketsCovering(undefined, undefined);
    expect(buckets).toHaveLength(16);
    expect(buckets[0]).toBe('A#00001');
    expect(buckets[15]).toBe('A#00016');
  });

  it('逆転した範囲・負数を拒否する', () => {
    expect(() => amountBucketsCovering(100, 10)).toThrow(ValidationError);
    expect(() => amountBucketsCovering(-1, 10)).toThrow(ValidationError);
  });
});

describe('counterpartyPartition', () => {
  it('C# 接頭辞を付ける', () => {
    expect(counterpartyPartition('サンプル商事')).toBe('C#サンプル商事');
  });

  it('空文字を拒否する', () => {
    expect(() => counterpartyPartition('')).toThrow(ValidationError);
  });
});

describe('toIndexRecord', () => {
  it('取引先名を正規化して保持する', () => {
    const record = fixture({ counterpartyNormalized: '㈱サンプル商事' });
    expect(record.counterpartyNormalized).toBe('サンプル商事');
    expect(record.voucherId).toBe('v-001');
    expect(record.transactionDate).toBe('2026-10-15');
    expect(record.amountYen).toBe(12_345);
    expect(record.documentType).toBe('invoice');
    expect(record.sequence).toBe(1);
  });

  it('証憑 ID が空なら拒否する', () => {
    expect(() => fixture({ voucherId: '  ' })).toThrow(ValidationError);
  });

  it('不正な日付・金額・連番を拒否する', () => {
    expect(() => fixture({ transactionDate: '2026-02-30' })).toThrow(ValidationError);
    expect(() => fixture({ amountYen: -1 })).toThrow(ValidationError);
    expect(() => fixture({ sequence: 0 })).toThrow(ValidationError);
    expect(() => fixture({ sequence: 1.5 })).toThrow(ValidationError);
  });

  it('取引先名が空（法人格のみ）なら拒否する', () => {
    expect(() => fixture({ counterpartyNormalized: '株式会社' })).toThrow(ValidationError);
  });
});

describe('deriveIndexEntries', () => {
  it('5 本すべての索引エントリを INDEX_NAMES の順で返す', () => {
    const entries = deriveIndexEntries(fixture({ amountYen: 12_345 }));
    expect(entries.map((entry) => entry.index)).toEqual([...INDEX_NAMES]);
    expect(entries).toHaveLength(5);
  });

  it('pk / sk が設計どおりになる', () => {
    // amount 12345 → 16 桁ゼロ埋めで '0000000000012345'
    const keys = deriveIndexEntries(fixture({ amountYen: 12_345 })).map(
      (entry) => `${entry.index}|${entry.partitionKey}|${entry.sortKey}`,
    );
    expect(keys).toEqual([
      'by-date|D#2026-10|2026-10-15#0000000000012345#v-001',
      'by-amount|A#00005|0000000000012345#v-001',
      'by-counterparty|C#サンプル商事|2026-10-15#v-001',
      'by-counterparty-date|C#サンプル商事#D#2026-10|2026-10-15#v-001',
      'by-counterparty-amount|C#サンプル商事#A#00005|0000000000012345#v-001',
    ]);
  });

  it('エントリ内のレコードは正規化済みの複製を持つ', () => {
    const entries = deriveIndexEntries(fixture({ counterpartyNormalized: '㈱サンプル商事' }));
    for (const entry of entries) {
      expect(entry.record.counterpartyNormalized).toBe('サンプル商事');
      expect(entry.record.voucherId).toBe('v-001');
    }
  });

  it('同じ日付では金額の辞書順が数値順と一致する（by-date の sk で範囲検索できる根拠）', () => {
    const amounts = [10, 2, 100];
    const sortKeys = amounts.map((amount) => {
      const entry = deriveIndexEntries(fixture({ amountYen: amount, voucherId: `v-${amount}` })).find(
        (candidate) => candidate.index === 'by-date',
      );
      if (entry === undefined) {
        throw new Error('by-date エントリが見つかりません');
      }
      return entry.sortKey;
    });
    expect([...sortKeys].sort()).toEqual([
      '2026-10-15#0000000000000002#v-2',
      '2026-10-15#0000000000000010#v-10',
      '2026-10-15#0000000000000100#v-100',
    ]);
  });

  it('不正なレコードは拒否する', () => {
    const broken: IndexRecord = { ...fixture(), voucherId: '' };
    expect(() => deriveIndexEntries(broken)).toThrow(ValidationError);
  });
});
