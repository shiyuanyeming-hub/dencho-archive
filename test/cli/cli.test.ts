/**
 * CLI の統合テスト。
 *
 * `run()` に出力先と作業ディレクトリを注入できるため、子プロセスを
 * 起動せずに終了コードと出力を検証できる（速く、環境に依存しない）。
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { run } from '../../src/cli/main.js';

interface Captured {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

let cwd: string;

async function cli(argv: readonly string[]): Promise<Captured> {
  let stdout = '';
  let stderr = '';
  const code = await run(argv, {
    stdout: (line) => {
      stdout += `${line}\n`;
    },
    stderr: (line) => {
      stderr += `${line}\n`;
    },
    cwd,
  });
  return { code, stdout, stderr };
}

beforeEach(async () => {
  cwd = await mkdtemp(path.join(tmpdir(), 'dencho-cli-'));
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

describe('基本', () => {
  it('--version は終了コード 0 でバージョンを出す', async () => {
    const { code, stdout } = await cli(['--version']);
    expect(code).toBe(0);
    expect(stdout).toMatch(/dencho-archive \d+\.\d+\.\d+/);
  });

  it('--help は使い方を出す', async () => {
    const { code, stdout } = await cli(['--help']);
    expect(code).toBe(0);
    expect(stdout).toContain('使い方');
    expect(stdout).toContain('audit');
  });

  it('未知のコマンドは終了コード 2', async () => {
    const { code, stderr } = await cli(['nope']);
    expect(code).toBe(2);
    expect(stderr).toContain('未知のコマンド');
  });

  it('未知のオプションは終了コード 2', async () => {
    const { code, stderr } = await cli(['search', '--nope', 'x']);
    expect(code).toBe(2);
    expect(stderr).toContain('未知のオプション');
  });

  it('値の無いオプションは終了コード 2', async () => {
    const { code, stderr } = await cli(['ingest', '--voucher-id']);
    expect(code).toBe(2);
    expect(stderr).toContain('値が必要');
  });
});

describe('init / ingest / search', () => {
  it('アーカイブを初期化できる', async () => {
    const { code, stdout } = await cli(['init', '--dir', 'archive']);
    expect(code).toBe(0);
    expect(stdout).toContain('初期化');
    const manifest = await readFile(path.join(cwd, 'archive', 'manifest.json'), 'utf8');
    expect(JSON.parse(manifest)).toHaveProperty('entries');
  });

  it('ファイルを取り込んで検索できる', async () => {
    await writeFile(path.join(cwd, 'invoice.txt'), '請求書の内容', 'utf8');
    const ingest = await cli([
      'ingest',
      'invoice.txt',
      '--dir',
      'archive',
      '--voucher-id',
      'INV-001',
      '--date',
      '2026-04-15',
      '--amount',
      '330000',
      '--counterparty',
      '株式会社サンプル商事',
      '--type',
      'invoice',
    ]);
    expect(ingest.code).toBe(0);
    expect(ingest.stdout).toContain('取り込みました');

    const search = await cli(['search', '--dir', 'archive', '--json', '--from', '2026-04-01', '--to', '2026-04-30']);
    expect(search.code).toBe(0);
    const parsed = JSON.parse(search.stdout) as { count: number; vouchers: { voucherId: string }[] };
    expect(parsed.count).toBe(1);
    expect(parsed.vouchers[0]?.voucherId).toBe('INV-001');
  });

  it('バルク取り込みができる', async () => {
    await writeFile(path.join(cwd, 'a.txt'), 'A の内容', 'utf8');
    await writeFile(path.join(cwd, 'b.txt'), 'B の内容', 'utf8');
    await writeFile(
      path.join(cwd, 'bulk.json'),
      JSON.stringify({
        baseDir: '.',
        vouchers: [
          { file: 'a.txt', voucherId: 'A-1', transactionDate: '2026-04-01', amountYen: 1000, counterparty: { name: '株式会社A' } },
          { file: 'b.txt', voucherId: 'B-1', transactionDate: '2026-05-01', amountYen: 2000, counterparty: { name: '株式会社B' } },
        ],
      }),
      'utf8',
    );
    const { code, stdout } = await cli(['ingest', '--dir', 'archive', '--bulk', 'bulk.json']);
    expect(code).toBe(0);
    expect(stdout).toContain('2 件を取り込みました');
  });

  it('金額の範囲指定で検索できる', async () => {
    await writeFile(path.join(cwd, 'x.txt'), 'x', 'utf8');
    await cli(['ingest', 'x.txt', '--dir', 'd', '--voucher-id', 'X-1', '--date', '2026-04-01', '--amount', '500000', '--counterparty', '株式会社X']);
    const { stdout } = await cli(['search', '--dir', 'd', '--json', '--amount-min', '100000', '--amount-max', '600000']);
    const parsed = JSON.parse(stdout) as { count: number };
    expect(parsed.count).toBe(1);
  });
});

describe('export / verify / audit / capability', () => {
  async function seed(): Promise<void> {
    await writeFile(path.join(cwd, 'invoice.txt'), '請求書', 'utf8');
    await cli([
      'ingest',
      'invoice.txt',
      '--dir',
      'archive',
      '--voucher-id',
      'INV-001',
      '--date',
      '2026-04-15',
      '--amount',
      '330000',
      '--counterparty',
      '株式会社サンプル商事',
    ]);
  }

  it('CSV を出力でき、BOM が付く', async () => {
    await seed();
    const { code, stdout } = await cli([
      'export',
      '--dir',
      'archive',
      '--format',
      'csv',
      '--out',
      'out/export.csv',
      '--from',
      '2026-01-01',
    ]);
    expect(code).toBe(0);
    expect(stdout).toContain('出力しました');
    const bytes = await readFile(path.join(cwd, 'out', 'export.csv'));
    expect(bytes[0]).toBe(0xef);
    expect(bytes.toString('utf8')).toContain('取引年月日');
  });

  it('verify は整合していれば 0', async () => {
    await seed();
    const { code, stdout } = await cli(['verify', '--dir', 'archive']);
    expect(code).toBe(0);
    expect(stdout).toContain('整合');
  });

  it('audit --infra none はアーカイブ側の判定を出す', async () => {
    await seed();
    const { code, stdout } = await cli(['audit', '--dir', 'archive', '--infra', 'none', '--format', 'json']);
    expect(code).toBe(0);
    const report = JSON.parse(stdout) as { verdict: string; results: { ruleId: string }[] };
    expect(report.verdict).toBe('compliant');
    expect(report.results.some((result) => result.ruleId === 'AUTH-01')).toBe(true);
  });

  it('audit はレポートをファイルへ書き出せる', async () => {
    await seed();
    const { code } = await cli(['audit', '--dir', 'archive', '--infra', 'none', '--out', 'reports/audit.md']);
    expect(code).toBe(0);
    const markdown = await readFile(path.join(cwd, 'reports', 'audit.md'), 'utf8');
    expect(markdown).toContain('#');
    expect(markdown).toContain('AUTH-01');
  });

  it('capability は検索要件の充足を表示する', async () => {
    const { code, stdout } = await cli(['capability', '--dir', 'archive', '--json']);
    expect(code).toBe(0);
    const capability = JSON.parse(stdout) as { searchableFields: string[] };
    expect(capability.searchableFields).toEqual(
      expect.arrayContaining(['transactionDate', 'amount', 'counterparty']),
    );
  });

  it('reindex は索引を再構築する', async () => {
    await seed();
    const { code, stdout } = await cli(['reindex', '--dir', 'archive']);
    expect(code).toBe(0);
    expect(stdout).toContain('再構築');
  });
});
