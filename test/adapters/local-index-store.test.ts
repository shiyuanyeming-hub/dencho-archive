/**
 * ローカル索引ストア（JSON 永続化）のテスト。
 *
 * 「CLI の別プロセスからでも検索できる」ことを保証するため、
 * 永続化・原子的書き込み・読み込み時の破損検出・再構築を固定する。
 * 複数プロセスからの同時書き込みは想定しない（索引は台帳から再構築できる派生物）。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { DocumentType, IndexEntry, IndexRecord } from '../../src/core/types.js';
import { IntegrityError, ValidationError } from '../../src/core/errors.js';
import { INDEX_NAMES, deriveIndexEntries, toIndexRecord } from '../../src/core/index-keys.js';
import { LocalIndexStore } from '../../src/adapters/local/index-store.js';

/** テスト用の証憑（索引レコードの元データ）。 */
interface SeedVoucher {
  readonly voucherId: string;
  readonly transactionDate: string;
  readonly amountYen: number;
  readonly counterparty: string;
  readonly documentType: DocumentType;
  readonly sequence: number;
}

const SEEDS: readonly SeedVoucher[] = [
  { voucherId: 'v-001', transactionDate: '2026-01-05', amountYen: 1_200, counterparty: '株式会社サンプル商事', documentType: 'invoice', sequence: 1 },
  { voucherId: 'v-002', transactionDate: '2026-02-10', amountYen: 980_000, counterparty: '株式会社サンプル商事', documentType: 'invoice', sequence: 2 },
  { voucherId: 'v-003', transactionDate: '2026-02-28', amountYen: 0, counterparty: 'その他商店', documentType: 'receipt', sequence: 3 },
];

/** シードから索引エントリ一式を作る。 */
function entriesOf(seeds: readonly SeedVoucher[]): readonly IndexEntry[] {
  return seeds.flatMap((seed) =>
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
}

/** 1 件分の索引レコードを作る（上書き・検証テスト用）。 */
function recordOf(voucherId = 'v-001', transactionDate = '2026-01-05'): IndexRecord {
  return toIndexRecord({
    voucherId,
    transactionDate,
    amountYen: 1_200,
    counterpartyNormalized: 'サンプル商事',
    documentType: 'invoice',
    sequence: 1,
  });
}

/** 索引ファイルの検証用の型。 */
interface ParsedIndexFile {
  readonly schemaVersion: number;
  readonly entries: readonly {
    readonly index: string;
    readonly partitionKey: string;
    readonly sortKey: string;
  }[];
}

let tempDir = '';
let indexPath = '';
let store: LocalIndexStore;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'dencho-index-'));
  indexPath = join(tempDir, 'index.json');
  store = new LocalIndexStore(indexPath);
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

/** 索引ファイルを読み出してパースする。 */
async function readIndexFile(): Promise<ParsedIndexFile> {
  return JSON.parse(await readFile(indexPath, 'utf8')) as ParsedIndexFile;
}

describe('LocalIndexStore: 基本操作', () => {
  it('ファイルが無い場合は空の索引として扱う', async () => {
    expect(await store.query({ index: 'by-date', partitionKey: 'D#2026-01' })).toEqual([]);
    expect(await store.stats()).toEqual({
      'by-date': 0,
      'by-amount': 0,
      'by-counterparty': 0,
      'by-counterparty-date': 0,
      'by-counterparty-amount': 0,
    });
  });

  it('put したエントリをパーティションキー完全一致で引ける', async () => {
    await store.put(entriesOf(SEEDS));
    const records = await store.query({ index: 'by-date', partitionKey: 'D#2026-02' });
    expect(records.map((record) => record.voucherId)).toEqual(['v-002', 'v-003']);
  });

  it('ソートキーの範囲（両端含む）で絞れる', async () => {
    await store.put(entriesOf(SEEDS));
    const all = await store.query({ index: 'by-counterparty', partitionKey: 'C#サンプル商事' });
    expect(all.map((record) => record.voucherId)).toEqual(['v-001', 'v-002']);

    const february = await store.query({
      index: 'by-counterparty',
      partitionKey: 'C#サンプル商事',
      sortKeyFrom: '2026-02-01#',
      sortKeyTo: `2026-02-28#\u{10FFFF}`,
    });
    expect(february.map((record) => record.voucherId)).toEqual(['v-002']);
  });

  it('sortKeyFrom のみ / sortKeyTo のみでも絞れる', async () => {
    await store.put(entriesOf(SEEDS));
    const fromOnly = await store.query({
      index: 'by-date',
      partitionKey: 'D#2026-02',
      sortKeyFrom: '2026-02-11#',
    });
    expect(fromOnly.map((record) => record.voucherId)).toEqual(['v-003']);

    const toOnly = await store.query({
      index: 'by-date',
      partitionKey: 'D#2026-02',
      sortKeyTo: '2026-02-10#\u{10FFFF}',
    });
    expect(toOnly.map((record) => record.voucherId)).toEqual(['v-002']);
  });

  it('存在しないパーティションキーは空配列を返す', async () => {
    await store.put(entriesOf(SEEDS));
    expect(await store.query({ index: 'by-date', partitionKey: 'D#1999-01' })).toEqual([]);
    expect(await store.query({ index: 'by-counterparty', partitionKey: 'C#存在しない' })).toEqual([]);
  });

  it('stats は索引ごとのエントリ数を返す', async () => {
    await store.put(entriesOf(SEEDS));
    expect(await store.stats()).toEqual({
      'by-date': 3,
      'by-amount': 3,
      'by-counterparty': 3,
      'by-counterparty-date': 3,
      'by-counterparty-amount': 3,
    });
  });

  it('同じ pk / sk の put は上書きされ、重複しない', async () => {
    const entries = entriesOf(SEEDS);
    await store.put(entries);
    await store.put(entries);
    expect(await store.stats()).toEqual({
      'by-date': 3,
      'by-amount': 3,
      'by-counterparty': 3,
      'by-counterparty-date': 3,
      'by-counterparty-amount': 3,
    });
    expect(await store.query({ index: 'by-date', partitionKey: 'D#2026-01' })).toHaveLength(1);
  });

  it('rebuild は索引を全件入れ替える（再構築用）', async () => {
    await store.put(entriesOf(SEEDS));
    await store.rebuild(entriesOf(SEEDS.slice(0, 1)));
    expect(await store.stats()).toEqual({
      'by-date': 1,
      'by-amount': 1,
      'by-counterparty': 1,
      'by-counterparty-date': 1,
      'by-counterparty-amount': 1,
    });
    expect(await store.query({ index: 'by-date', partitionKey: 'D#2026-02' })).toEqual([]);
  });

  it('rebuild は重複キーを 1 件に畳む', async () => {
    const single = recordOf();
    const entries = [...deriveIndexEntries(single), ...deriveIndexEntries(single)];
    await store.rebuild(entries);
    expect((await store.stats())['by-date']).toBe(1);
  });

  it('空の put でもファイルを作り、空の索引として読める', async () => {
    await store.put([]);
    const file = await readIndexFile();
    expect(file.schemaVersion).toBe(1);
    expect(file.entries).toEqual([]);
    expect(await store.query({ index: 'by-date', partitionKey: 'D#2026-01' })).toEqual([]);
  });
});

describe('LocalIndexStore: 永続化', () => {
  it('別インスタンス（別プロセス相当）から読める', async () => {
    await store.put(entriesOf(SEEDS));

    const secondProcess = new LocalIndexStore(indexPath);
    const records = await secondProcess.query({ index: 'by-counterparty', partitionKey: 'C#サンプル商事' });
    expect(records.map((record) => record.voucherId)).toEqual(['v-001', 'v-002']);
  });

  it('ファイルは schemaVersion 1 を持ち、索引名順 → pk 順 → sk 順で並ぶ', async () => {
    await store.put(entriesOf(SEEDS));
    const file = await readIndexFile();
    expect(file.schemaVersion).toBe(1);
    expect(file.entries).toHaveLength(SEEDS.length * INDEX_NAMES.length);
    // 索引名は INDEX_NAMES の順にまとまり、各索引の内部は pk → sk 昇順。
    const indexSequence = file.entries.map((entry) => entry.index);
    expect(indexSequence.slice(0, 3)).toEqual(['by-date', 'by-date', 'by-date']);
    expect(indexSequence.slice(3, 6)).toEqual(['by-amount', 'by-amount', 'by-amount']);
    expect(indexSequence.at(-1)).toBe('by-counterparty-amount');
    const byDate = file.entries.filter((entry) => entry.index === 'by-date');
    expect(byDate.map((entry) => entry.partitionKey)).toEqual([
      'D#2026-01',
      'D#2026-02',
      'D#2026-02',
    ]);
  });

  it('親ディレクトリが無くても自動作成する', async () => {
    const nestedPath = join(tempDir, 'nested', 'deeper', 'index.json');
    const nestedStore = new LocalIndexStore(nestedPath);
    await nestedStore.put(entriesOf(SEEDS.slice(0, 1)));
    const file = JSON.parse(await readFile(nestedPath, 'utf8')) as ParsedIndexFile;
    expect(file.entries).toHaveLength(5);
  });

  it('同じ内容の再構築は同じファイル内容になる（決定的）', async () => {
    await store.rebuild(entriesOf(SEEDS));
    const first = await readFile(indexPath, 'utf8');
    await store.rebuild(entriesOf(SEEDS));
    const second = await readFile(indexPath, 'utf8');
    expect(second).toBe(first);
  });

  it('書き込み後に一時ファイルが残らない（原子的書き込み）', async () => {
    await store.put(entriesOf(SEEDS));
    await store.put(entriesOf(SEEDS.slice(0, 1)));
    const files = await readdir(tempDir);
    expect(files).toEqual(['index.json']);
  });
});

describe('LocalIndexStore: 破損データの検出', () => {
  it('JSON として壊れている場合は IntegrityError', async () => {
    await writeFile(indexPath, '{ これは JSON ではない', 'utf8');
    const broken = new LocalIndexStore(indexPath);
    await expect(broken.query({ index: 'by-date', partitionKey: 'D#2026-01' })).rejects.toThrow(
      IntegrityError,
    );
  });

  it('schemaVersion が違う場合は IntegrityError', async () => {
    await writeFile(indexPath, JSON.stringify({ schemaVersion: 2, entries: [] }), 'utf8');
    const broken = new LocalIndexStore(indexPath);
    await expect(broken.stats()).rejects.toThrow(IntegrityError);
  });

  it('entries が配列でない場合は IntegrityError', async () => {
    await writeFile(indexPath, JSON.stringify({ schemaVersion: 1, entries: 'nope' }), 'utf8');
    const broken = new LocalIndexStore(indexPath);
    await expect(broken.stats()).rejects.toThrow(IntegrityError);
  });

  it('不正な索引名・壊れたレコードは IntegrityError（黙って 0 件にしない）', async () => {
    await writeFile(
      indexPath,
      JSON.stringify({
        schemaVersion: 1,
        entries: [{ index: 'by-nope', partitionKey: 'x', sortKey: 'y', record: {} }],
      }),
      'utf8',
    );
    const broken = new LocalIndexStore(indexPath);
    await expect(broken.stats()).rejects.toThrow(IntegrityError);
  });

  it('rebuild は破損ファイルを上書きして復旧できる（索引は派生物である）', async () => {
    await writeFile(indexPath, 'broken!', 'utf8');
    const recovered = new LocalIndexStore(indexPath);
    await recovered.rebuild(entriesOf(SEEDS));

    const fresh = new LocalIndexStore(indexPath);
    expect(await fresh.stats()).toEqual({
      'by-date': 3,
      'by-amount': 3,
      'by-counterparty': 3,
      'by-counterparty-date': 3,
      'by-counterparty-amount': 3,
    });
  });
});

describe('LocalIndexStore: 入力検証', () => {
  it('空のパーティションキーを持つエントリを拒否する', async () => {
    const broken: IndexEntry = {
      index: 'by-date',
      partitionKey: '',
      sortKey: '2026-01-05#0000000000001200#v-001',
      record: recordOf(),
    };
    await expect(store.put([broken])).rejects.toThrow(ValidationError);
    await expect(store.rebuild([broken])).rejects.toThrow(ValidationError);
  });

  it('パスが空のストアは生成できない', () => {
    expect(() => new LocalIndexStore('  ')).toThrow(ValidationError);
  });
});
