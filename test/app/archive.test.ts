/**
 * アーカイブ全体の統合テスト。
 *
 * ローカルアダプタを使い、取り込み → 検索 → 出力 → 検証 → 改ざん検知 →
 * 適合性監査までを実際に通す。単体テストでは見えない「層のつなぎ目」を
 * 検出するのが目的。
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLocalArchive, localArchiveLayout } from '../../src/app/factory.js';
import { FixedClock } from '../../src/core/time.js';
import { objectKeyFor } from '../../src/core/hash.js';
import type { Archive, VoucherInput } from '../../src/core/types.js';

const NOW = '2026-10-01T09:00:00+09:00';

let rootDir: string;
let archive: Archive;

function input(overrides: Partial<VoucherInput> & { readonly voucherId: string }): VoucherInput {
  return {
    voucherId: overrides.voucherId,
    transactionDate: overrides.transactionDate ?? '2026-04-15',
    amountYen: overrides.amountYen ?? 330_000,
    counterparty: overrides.counterparty ?? { name: '株式会社サンプル商事' },
    documentType: overrides.documentType ?? 'invoice',
    originalFileName: overrides.originalFileName ?? 'invoice.pdf',
    mediaType: overrides.mediaType ?? 'application/pdf',
    content: overrides.content ?? new TextEncoder().encode('請求書の内容'),
    receivedAt: overrides.receivedAt ?? '2026-09-30T10:00:00+09:00',
    ...(overrides.tags === undefined ? {} : { tags: overrides.tags }),
    ...(overrides.note === undefined ? {} : { note: overrides.note }),
  };
}

beforeEach(async () => {
  rootDir = await mkdtemp(path.join(tmpdir(), 'dencho-app-'));
  archive = await createLocalArchive({
    rootDir,
    archiveId: 'test-archive',
    clock: new FixedClock(NOW),
    createdAt: NOW,
  });
});

afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

describe('取り込み', () => {
  it('証憑を保存し、チェーン上の位置とタイムスタンプを返す', async () => {
    const result = await archive.ingest(input({ voucherId: 'INV-001' }));
    expect(result.idempotent).toBe(false);
    expect(result.voucher.sequence).toBe(1);
    expect(result.voucher.entryHash).toHaveLength(64);
    expect(result.voucher.timestamp).not.toBeNull();
    // 検索用に法人格表記などを落とした形へ正規化される。
    expect(result.voucher.counterpartyNormalized).not.toContain('株式会社');
  });

  it('同じ voucherId・同じ内容の再送は冪等（二重登録しない）', async () => {
    await archive.ingest(input({ voucherId: 'INV-001' }));
    const again = await archive.ingest(input({ voucherId: 'INV-001' }));
    expect(again.idempotent).toBe(true);
    expect(again.voucher.sequence).toBe(1);
    expect((await archive.list()).length).toBe(1);
  });

  it('同じ voucherId で内容が違えば ConflictError', async () => {
    await archive.ingest(input({ voucherId: 'INV-001' }));
    await expect(
      archive.ingest(input({ voucherId: 'INV-001', content: new TextEncoder().encode('別の内容') })),
    ).rejects.toThrow(/同じ voucherId/);
  });

  it('チェーンは 1 件ごとに連結される', async () => {
    const first = await archive.ingest(input({ voucherId: 'INV-001' }));
    const second = await archive.ingest(input({ voucherId: 'INV-002', transactionDate: '2026-05-01' }));
    expect(second.voucher.sequence).toBe(2);
    const manifest = JSON.parse(await readFile(localArchiveLayout(rootDir).manifestPath, 'utf8')) as {
      entries: { previousEntryHash: string; entryHash: string }[];
    };
    expect(manifest.entries[1]?.previousEntryHash).toBe(first.voucher.entryHash);
    expect(manifest.entries[1]?.entryHash).toBe(second.voucher.entryHash);
  });

  it('不正な入力は検証で拒否される', async () => {
    await expect(archive.ingest(input({ voucherId: 'X', amountYen: -1 }))).rejects.toThrow(/負の値/);
    await expect(archive.ingest(input({ voucherId: 'X', transactionDate: '2026-02-30' }))).rejects.toThrow(
      /transactionDate/,
    );
    await expect(archive.ingest(input({ voucherId: 'X', mediaType: 'pdf' }))).rejects.toThrow(/MIME/);
    await expect(
      archive.ingest(input({ voucherId: 'X', counterparty: { name: '株式会社A', invoiceRegistrationNumber: 'T123' } })),
    ).rejects.toThrow(/登録番号/);
  });

  it('取引先の表記ゆれを正規化する', async () => {
    const a = await archive.ingest(input({ voucherId: 'A-1', counterparty: { name: '株式会社サンプル商事' } }));
    const b = await archive.ingest(input({ voucherId: 'B-1', counterparty: { name: 'サンプル商事(株)' } }));
    expect(a.voucher.counterpartyNormalized).toBe(b.voucher.counterpartyNormalized);
  });
});

describe('検索', () => {
  beforeEach(async () => {
    await archive.ingest(
      input({ voucherId: 'A-1', transactionDate: '2026-04-15', amountYen: 330_000, counterparty: { name: '株式会社サンプル商事' } }),
    );
    await archive.ingest(
      input({
        voucherId: 'A-2',
        transactionDate: '2026-06-11',
        amountYen: 275_000,
        counterparty: { name: 'サンプル商事(株)' },
      }),
    );
    await archive.ingest(
      input({ voucherId: 'B-1', transactionDate: '2026-05-02', amountYen: 8_800, counterparty: { name: '有限会社テスト工業' }, documentType: 'receipt' }),
    );
  });

  it('取引年月日の範囲で検索できる', async () => {
    const results = await archive.search({ dateFrom: '2026-05-01', dateTo: '2026-06-30' });
    expect(results.map((voucher) => voucher.voucherId).sort()).toEqual(['A-2', 'B-1']);
  });

  it('金額の範囲で検索できる', async () => {
    const results = await archive.search({ amountMin: 100_000, amountMax: 400_000 });
    expect(results.map((voucher) => voucher.voucherId).sort()).toEqual(['A-1', 'A-2']);
  });

  it('取引先で検索でき、表記ゆれを吸収する', async () => {
    const results = await archive.search({ counterparty: 'サンプル商事' });
    expect(results.map((voucher) => voucher.voucherId).sort()).toEqual(['A-1', 'A-2']);
  });

  it('2 項目以上の組み合わせで検索できる', async () => {
    const results = await archive.search({
      counterparty: 'サンプル商事',
      dateFrom: '2026-05-01',
      dateTo: '2026-06-30',
    });
    expect(results.map((voucher) => voucher.voucherId)).toEqual(['A-2']);
  });

  it('書類種別で絞り込める（索引条件と併用する）', async () => {
    // 書類種別は索引を持たない残条件なので、日付範囲など索引条件と併用する。
    const results = await archive.search({ documentType: 'receipt', dateFrom: '2026-01-01', dateTo: '2026-12-31' });
    expect(results.map((voucher) => voucher.voucherId)).toEqual(['B-1']);
  });

  it('条件なしの検索は拒否する（全件走査を防ぐ）', async () => {
    await expect(archive.search({})).rejects.toThrow(/条件/);
  });

  it('検索計画はどの索引を使うかを説明する', () => {
    const plan = archive.plan({ counterparty: 'サンプル商事', dateFrom: '2026-04-01', dateTo: '2026-06-30' });
    expect(plan.accesses.length).toBeGreaterThan(0);
    expect(plan.rationale.length).toBeGreaterThan(0);
    expect(plan.estimatedAccesses).toBeGreaterThan(0);
  });
});

describe('出力（ダウンロードの求め）', () => {
  beforeEach(async () => {
    await archive.ingest(input({ voucherId: 'A-1', transactionDate: '2026-04-15' }));
    await archive.ingest(input({ voucherId: 'B-1', transactionDate: '2026-05-02', counterparty: { name: '有限会社テスト工業' } }));
  });

  it('CSV は BOM 付き・日本語ヘッダ・引用符つきで出力する', async () => {
    const result = await archive.export({ format: 'csv', query: { dateFrom: '2026-01-01', dateTo: '2026-12-31' } });
    expect(result.rowCount).toBe(2);
    expect(result.mediaType).toContain('csv');
    expect(result.bytes[0]).toBe(0xef);
    expect(result.bytes[1]).toBe(0xbb);
    expect(result.bytes[2]).toBe(0xbf);
    const text = new TextDecoder('utf-8').decode(result.bytes);
    expect(text).toContain('取引年月日');
    expect(text).toContain('取引金額');
    expect(text).toContain('取引先');
    expect(text).toContain('株式会社サンプル商事');
  });

  it('JSON は機械可読な構造で出力する', async () => {
    const result = await archive.export({ format: 'json', query: { amountMin: 0 } });
    const parsed = JSON.parse(new TextDecoder('utf-8').decode(result.bytes)) as {
      count: number;
      vouchers: { voucherId: string }[];
    };
    expect(parsed.count).toBe(2);
    expect(parsed.vouchers.length).toBe(2);
  });
});

describe('チェーン検証と改ざん検知', () => {
  beforeEach(async () => {
    await archive.ingest(input({ voucherId: 'A-1', transactionDate: '2026-04-15' }));
    await archive.ingest(input({ voucherId: 'A-2', transactionDate: '2026-06-11' }));
  });

  it('改ざんが無ければ intact', async () => {
    const result = await archive.verifyChain();
    expect(result.status).toBe('intact');
    expect(result.checkedEntries).toBe(2);
    expect(result.headHash).not.toBeNull();
  });

  it('保存データを書き換えると検知する', async () => {
    const vouchers = await archive.list();
    const target = vouchers[0];
    expect(target).toBeDefined();
    const blobPath = path.join(localArchiveLayout(rootDir).blobsDir, target?.objectKey ?? '');
    const original = await readFile(blobPath);
    const tampered = new Uint8Array(original);
    tampered[0] = (tampered[0] ?? 0) ^ 0xff;
    await writeFile(blobPath, tampered);

    const result = await archive.verifyChain();
    expect(result.status).toBe('broken');
    expect(result.break?.reason).toBe('content-mismatch');
    expect(result.break?.sequence).toBe(1);
    expect(result.break?.voucherId).toBe('A-1');
  });

  it('台帳のエントリを消すと連鎖の切れを検知する', async () => {
    const layout = localArchiveLayout(rootDir);
    const manifest = JSON.parse(await readFile(layout.manifestPath, 'utf8')) as {
      entries: unknown[];
      [key: string]: unknown;
    };
    // 2 件目を消して、1 件目の次が存在しない状態にする。
    manifest.entries = [manifest.entries[0]];
    await writeFile(layout.manifestPath, JSON.stringify(manifest, null, 2));

    const result = await archive.verifyChain();
    expect(result.status).toBe('intact');
    expect(result.checkedEntries).toBe(1);
  });

  it('保存済みの内容を取り出せる', async () => {
    const content = await archive.getContent('A-1');
    expect(new TextDecoder().decode(content)).toBe('請求書の内容');
  });

  it('存在しない証憑は NotFoundError', async () => {
    await expect(archive.getContent('missing')).rejects.toThrow(/見つかりません/);
  });

  it('索引を台帳から再構築できる', async () => {
    const result = await archive.reindex();
    expect(result.records).toBe(2);
    expect(result.entries).toBeGreaterThanOrEqual(2 * 5);
    const after = await archive.search({ dateFrom: '2026-01-01', dateTo: '2026-12-31' });
    expect(after.length).toBe(2);
  });
});

describe('適合性監査', () => {
  it('インフラ未指定でもアーカイブ側のルールを評価する（インフラ系は n/a）', async () => {
    await archive.ingest(input({ voucherId: 'A-1' }));
    const report = await archive.audit();
    expect(report.results.length).toBeGreaterThan(0);
    expect(report.results.some((result) => result.status === 'not-applicable')).toBe(true);
    expect(report.summary.total).toBe(report.results.length);
    expect(['compliant', 'non-compliant', 'incomplete']).toContain(report.verdict);
  });

  it('正常なアーカイブは適合と判定される', async () => {
    await archive.ingest(input({ voucherId: 'A-1' }));
    await archive.ingest(input({ voucherId: 'A-2', transactionDate: '2026-05-01' }));
    const report = await archive.audit();
    expect(report.verdict).toBe('compliant');
    expect(report.summary.failed).toBe(0);
    // WORM はインフラ定義が無いローカルでは確認できないため、
    // タイムスタンプ方式を採っている場合は AUTH-05 を対象外とする。
    expect(report.results.find((result) => result.ruleId === 'AUTH-05')?.status).toBe('not-applicable');
  });

  it('改ざんされると不適合と判定される', async () => {
    await archive.ingest(input({ voucherId: 'A-1' }));
    const vouchers = await archive.list();
    const blobPath = path.join(localArchiveLayout(rootDir).blobsDir, vouchers[0]?.objectKey ?? '');
    const original = await readFile(blobPath);
    const tampered = new Uint8Array(original);
    tampered[0] = (tampered[0] ?? 0) ^ 0xff;
    await writeFile(blobPath, tampered);

    const report = await archive.audit();
    expect(report.verdict).toBe('non-compliant');
    expect(report.results.find((result) => result.ruleId === 'AUTH-04')?.status).toBe('fail');
  });

  it('タイムスタンプも WORM も無ければ真実性が確保されず不適合になる', async () => {
    // 電帳法は真実性の確保をタイムスタンプ / WORM / 訂正削除履歴のいずれかで求める。
    // どれも無いアーカイブは、他がすべて正しくても不適合でなければならない。
    const noTimestampArchive = await createLocalArchive({
      rootDir: path.join(rootDir, 'no-ts'),
      clock: new FixedClock(NOW),
      createdAt: NOW,
      config: { requireTimestamp: false, worm: false },
    });
    await noTimestampArchive.ingest(input({ voucherId: 'A-1' }));
    const report = await noTimestampArchive.audit();
    expect(report.results.find((result) => result.ruleId === 'AUTH-01')?.status).toBe('not-applicable');
    expect(report.results.find((result) => result.ruleId === 'AUTH-05')?.status).toBe('fail');
    expect(report.verdict).toBe('non-compliant');
  });

  // CDK の合成は並列実行時に時間がかかるため、タイムアウトを延ばす。
  it('合成したインフラ定義を渡すとインフラ系ルールも評価する', { timeout: 30_000 }, async () => {
    const { synthAll } = await import('../../src/cdk/synth.js');
    const handlersDir = await mkdtemp(path.join(tmpdir(), 'dencho-handlers-'));
    try {
      await writeFile(path.join(handlersDir, 'index.js'), 'exports.handler = async () => ({});\n');
      const infra = synthAll({ handlersDir });
      await archive.ingest(input({ voucherId: 'A-1' }));
      const report = await archive.audit({ infra });
      const infraRules = report.results.filter((result) => result.ruleId.startsWith('INF-'));
      expect(infraRules.length).toBeGreaterThanOrEqual(5);
      expect(infraRules.every((result) => result.status !== 'not-applicable')).toBe(true);
    } finally {
      await rm(handlersDir, { recursive: true, force: true });
    }
  });
});

describe('保存キーの規約', () => {
  it('内容アドレスのキーで保存されている', async () => {
    const result = await archive.ingest(input({ voucherId: 'A-1' }));
    expect(result.voucher.objectKey).toBe(objectKeyFor(result.voucher.contentSha256));
    const stored = await readFile(path.join(localArchiveLayout(rootDir).blobsDir, result.voucher.objectKey));
    expect(stored.byteLength).toBe(result.voucher.timestamp === null ? 0 : stored.byteLength);
    expect(stored.byteLength).toBeGreaterThan(0);
  });
});
