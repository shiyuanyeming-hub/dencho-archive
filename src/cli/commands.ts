/**
 * CLI サブコマンドの実装。
 *
 * 表示（人が読む）と `--json`（機械可読）の両方を用意し、
 * CI とデモのどちらでも使えるようにする。
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { Archive, DocumentType, ExportFormat, InfraSnapshot, VoucherQuery } from '../core/types.js';
import { isIsoDateInRange } from '../core/time.js';
import { ValidationError } from '../core/errors.js';
import { createLocalArchive, localArchiveLayout } from '../app/factory.js';
import { auditExitCode, renderAuditJson, renderAuditMarkdown } from '../compliance/index.js';
import { formatBytes, formatYen, heading, oneLine, renderTable, statusMark } from './format.js';
import { CliError, flag, optionalInteger, requireFlag, type ParsedArgs } from './args.js';

/** 出力先。テストで差し替える。 */
export interface CommandIo {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
  readonly cwd: string;
}

/** CLI の終了コード。 */
export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_ERROR = 2;

const DEFAULT_DIR = '.dencho';

/** `--dir` の値を解決する。 */
function archiveDir(args: ParsedArgs, io: CommandIo): string {
  return path.resolve(io.cwd, args.values['dir'] ?? DEFAULT_DIR);
}

/** アーカイブを開く（無ければ作る）。 */
async function openArchive(args: ParsedArgs, io: CommandIo): Promise<Archive> {
  const dir = archiveDir(args, io);
  return createLocalArchive({ rootDir: dir });
}

/** 書類種別を解析する。 */
function parseDocumentType(value: string | undefined): DocumentType {
  const allowed: readonly DocumentType[] = [
    'invoice',
    'receipt',
    'delivery-note',
    'contract',
    'order',
    'statement',
    'other',
  ];
  if (value === undefined) {
    return 'other';
  }
  if (!allowed.includes(value as DocumentType)) {
    throw new CliError(`--type が不正です: ${value}（${allowed.join(' / ')}）`);
  }
  return value as DocumentType;
}

/** 検索条件を組み立てる。 */
function buildQuery(args: ParsedArgs): VoucherQuery {
  const dateFrom = args.values['from'];
  const dateTo = args.values['to'];
  const amountMin = optionalInteger(args, 'amount-min');
  const amountMax = optionalInteger(args, 'amount-max');
  const counterparty = args.values['counterparty'];
  const documentType = args.values['type'];
  const limit = optionalInteger(args, 'limit');

  const query: Mutable<VoucherQuery> = {};
  if (dateFrom !== undefined) query.dateFrom = dateFrom;
  if (dateTo !== undefined) query.dateTo = dateTo;
  if (amountMin !== undefined) query.amountMin = amountMin;
  if (amountMax !== undefined) query.amountMax = amountMax;
  if (counterparty !== undefined) query.counterparty = counterparty;
  if (documentType !== undefined) query.documentType = parseDocumentType(documentType);
  if (limit !== undefined) query.limit = limit;
  return query;
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/** `init` コマンド。 */
export async function commandInit(args: ParsedArgs, io: CommandIo): Promise<number> {
  const dir = archiveDir(args, io);
  const archiveId = args.values['archive-id'] ?? 'local-archive';
  const archive = await createLocalArchive({ rootDir: dir, archiveId, reset: false });
  const layout = localArchiveLayout(dir);
  if (flag(args, 'json')) {
    io.out(JSON.stringify({ dir: layout.rootDir, archiveId: archive.config.archiveId, retentionYears: archive.config.retentionYears }, null, 2));
    return EXIT_OK;
  }
  io.out(`アーカイブを初期化しました: ${layout.rootDir}`);
  io.out(`  アーカイブID : ${archive.config.archiveId}`);
  io.out(`  保存期間     : ${archive.config.retentionYears} 年`);
  io.out(`  必須項目     : 取引年月日 / 取引金額 / 取引先（電帳法の検索要件）`);
  return EXIT_OK;
}

/** `ingest` コマンド。 */
export async function commandIngest(args: ParsedArgs, io: CommandIo): Promise<number> {
  const archive = await openArchive(args, io);
  const bulk = args.values['bulk'];

  if (bulk !== undefined) {
    const manifestPath = path.resolve(io.cwd, bulk);
    const raw = JSON.parse(await readFile(manifestPath, 'utf8')) as BulkManifest;
    const baseDir = path.resolve(path.dirname(manifestPath), raw.baseDir ?? '.');
    const results: { voucherId: string; idempotent: boolean; bytes: number }[] = [];
    for (const item of raw.vouchers) {
      const content = await readFile(path.resolve(baseDir, item.file));
      const ingested = await archive.ingest({
        voucherId: item.voucherId,
        transactionDate: item.transactionDate,
        amountYen: item.amountYen,
        counterparty: {
          name: item.counterparty.name,
          ...(item.counterparty.invoiceRegistrationNumber === undefined
            ? {}
            : { invoiceRegistrationNumber: item.counterparty.invoiceRegistrationNumber }),
        },
        documentType: item.documentType ?? 'other',
        originalFileName: path.basename(item.file),
        mediaType: item.mediaType ?? guessMediaType(item.file),
        content,
        receivedAt: item.receivedAt ?? new Date().toISOString(),
        ...(item.tags === undefined ? {} : { tags: item.tags }),
        ...(item.note === undefined ? {} : { note: item.note }),
      });
      results.push({
        voucherId: ingested.voucher.voucherId,
        idempotent: ingested.idempotent,
        bytes: content.byteLength,
      });
    }

    if (flag(args, 'json')) {
      io.out(JSON.stringify({ ingested: results.length, results }, null, 2));
      return EXIT_OK;
    }
    io.out(
      renderTable(
        ['証憑ID', '結果', 'サイズ'],
        results.map((result) => [
          result.voucherId,
          result.idempotent ? '冪等（既存）' : '登録',
          formatBytes(result.bytes),
        ]),
      ),
    );
    io.out(`\n${results.length} 件を取り込みました（台帳 ${(await archive.list()).length} 件）。`);
    return EXIT_OK;
  }

  const file = args.positionals[0];
  if (file === undefined) {
    throw new CliError('取り込むファイルを指定してください（または --bulk を使う）');
  }
  const voucherId = requireFlag(args, 'voucher-id', '取引先の伝票番号など');
  const transactionDate = requireFlag(args, 'date', '取引年月日 YYYY-MM-DD');
  const amount = optionalInteger(args, 'amount');
  if (amount === undefined) {
    throw new CliError('--amount（取引金額・整数円）は必須です');
  }
  const counterpartyName = requireFlag(args, 'counterparty', '取引先名');
  const content = await readFile(path.resolve(io.cwd, file));
  const registration = args.values['registration'];

  const result = await archive.ingest({
    voucherId,
    transactionDate,
    amountYen: amount,
    counterparty: {
      name: counterpartyName,
      ...(registration === undefined ? {} : { invoiceRegistrationNumber: registration }),
    },
    documentType: parseDocumentType(args.values['type']),
    originalFileName: path.basename(file),
    mediaType: guessMediaType(file),
    content,
    receivedAt: args.values['received-at'] ?? new Date().toISOString(),
  });

  if (flag(args, 'json')) {
    io.out(JSON.stringify({ voucher: result.voucher, idempotent: result.idempotent }, null, 2));
    return EXIT_OK;
  }
  io.out(`取り込みました: ${result.voucher.voucherId}（第 ${result.voucher.sequence} 項）`);
  io.out(`  タイムスタンプ: ${result.voucher.timestamp === null ? 'なし' : '付与済み'}`);
  io.out(`  内容ハッシュ  : ${result.voucher.contentSha256.slice(0, 16)}…`);
  io.out(`  エントリハッシュ: ${result.voucher.entryHash.slice(0, 16)}…`);
  if (result.idempotent) {
    io.out('  同じ証憑が既に登録されていたため、新規登録は行いませんでした（冪等）。');
  }
  return EXIT_OK;
}

/** `search` コマンド。 */
export async function commandSearch(args: ParsedArgs, io: CommandIo): Promise<number> {
  const archive = await openArchive(args, io);
  const query = buildQuery(args);
  const vouchers = await archive.search(query);

  if (flag(args, 'json') || args.values['format'] === 'json') {
    io.out(JSON.stringify({ count: vouchers.length, vouchers }, null, 2));
    return EXIT_OK;
  }
  io.out(`検索結果: ${vouchers.length} 件`);
  if (vouchers.length === 0) {
    return EXIT_OK;
  }
  io.out(
    renderTable(
      ['#', '証憑ID', '取引年月日', '金額', '取引先', '種別', '保存時刻'],
      vouchers.map((voucher) => [
        String(voucher.sequence),
        voucher.voucherId,
        voucher.transactionDate,
        formatYen(voucher.amountYen),
        oneLine(voucher.counterpartyName, 24),
        voucher.documentType,
        voucher.recordedAt,
      ]),
    ),
  );
  const plan = archive.plan(query);
  io.err(`（検索計画: ${plan.rationale} / 索引アクセス ${plan.estimatedAccesses} 回）`);
  return EXIT_OK;
}

/** `export` コマンド。 */
export async function commandExport(args: ParsedArgs, io: CommandIo): Promise<number> {
  const archive = await openArchive(args, io);
  const format = (args.values['format'] ?? 'csv') as ExportFormat;
  if (format !== 'csv' && format !== 'json') {
    throw new CliError(`--format は csv か json を指定してください: ${format}`);
  }
  const query = buildQuery(args);
  const result = await archive.export({ format, query });
  const outPath = path.resolve(io.cwd, args.values['out'] ?? result.fileName);
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, result.bytes);
  if (flag(args, 'json')) {
    io.out(JSON.stringify({ path: outPath, fileName: result.fileName, rowCount: result.rowCount, bytes: result.bytes.byteLength }, null, 2));
    return EXIT_OK;
  }
  io.out(`${result.rowCount} 件を出力しました: ${outPath}`);
  io.out(`  形式: ${format.toUpperCase()} / ${formatBytes(result.bytes.byteLength)}`);
  io.out('  税務調査で「ダウンロードの求め」に応じられる形式です（検索条件で範囲を指定できます）。');
  return EXIT_OK;
}

/** `verify` コマンド。 */
export async function commandVerify(args: ParsedArgs, io: CommandIo): Promise<number> {
  const archive = await openArchive(args, io);
  const result = await archive.verifyChain();
  if (flag(args, 'json')) {
    io.out(JSON.stringify(result, null, 2));
  } else {
    io.out(`ハッシュチェーン検証: ${result.status === 'intact' ? '✓ 整合' : result.status === 'empty' ? '− 空' : '✗ 破損'}`);
    io.out(`  検証したエントリ: ${result.checkedEntries} 件`);
    io.out(`  先頭ハッシュ    : ${result.headHash?.slice(0, 24) ?? '(空)'}${result.headHash === null ? '' : '…'}`);
    io.out(`  チェックポイント: ${result.checkpointsVerified ? 'OK' : 'NG'}`);
    if (result.break !== undefined) {
      io.out('');
      io.out(`破損を検出しました: 第 ${result.break.sequence} 項（${result.break.voucherId}）`);
      io.out(`  理由: ${result.break.reason}`);
      io.out(`  期待: ${result.break.expected}`);
      io.out(`  実際: ${result.break.actual}`);
    }
  }
  return result.status === 'broken' ? EXIT_FAILED : EXIT_OK;
}

/** インフラ定義を読み込む。 */
async function loadInfra(args: ParsedArgs, io: CommandIo): Promise<InfraSnapshot | undefined> {
  const spec = args.values['infra'] ?? 'auto';
  if (spec === 'none' || flag(args, 'no-infra')) {
    return undefined;
  }
  if (spec === 'auto') {
    try {
      const module = await import('../cdk/synth.js');
      return module.synthAll();
    } catch (error) {
      io.err(`（インフラ定義の合成をスキップしました: ${error instanceof Error ? error.message : String(error)}）`);
      return undefined;
    }
  }
  const raw = JSON.parse(await readFile(path.resolve(io.cwd, spec), 'utf8')) as InfraSnapshot;
  return raw;
}

/** `audit` コマンド。 */
export async function commandAudit(args: ParsedArgs, io: CommandIo): Promise<number> {
  const archive = await openArchive(args, io);
  const infra = await loadInfra(args, io);
  const report = await archive.audit(infra === undefined ? {} : { infra });
  const format = args.values['format'] ?? (flag(args, 'json') ? 'json' : 'markdown');
  const rendered = format === 'json' ? renderAuditJson(report) : renderAuditMarkdown(report);

  const outPath = args.values['out'];
  if (outPath !== undefined) {
    const absolute = path.resolve(io.cwd, outPath);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, rendered, 'utf8');
    io.out(`監査レポートを書き出しました: ${absolute}`);
  } else {
    io.out(rendered);
  }

  const verdictLabel =
    report.verdict === 'compliant' ? '適合' : report.verdict === 'incomplete' ? '判定不能' : '不適合';
  io.err(
    `監査結果: ${verdictLabel}（pass ${report.summary.passed} / fail ${report.summary.failed} / n/a ${report.summary.notApplicable} / error ${report.summary.errored}）`,
  );
  return auditExitCode(report);
}

/** `reindex` コマンド。 */
export async function commandReindex(args: ParsedArgs, io: CommandIo): Promise<number> {
  const archive = await openArchive(args, io);
  const result = await archive.reindex();
  if (flag(args, 'json')) {
    io.out(JSON.stringify(result, null, 2));
    return EXIT_OK;
  }
  io.out(`検索索引を再構築しました: 証憑 ${result.records} 件 / 索引エントリ ${result.entries} 件`);
  return EXIT_OK;
}

/** `capability` コマンド。 */
export async function commandCapability(args: ParsedArgs, io: CommandIo): Promise<number> {
  const dir = archiveDir(args, io);
  const archive = await createLocalArchive({ rootDir: dir });
  const capability = archive.capability();
  if (flag(args, 'json')) {
    io.out(JSON.stringify(capability, null, 2));
    return EXIT_OK;
  }
  io.out(heading('検索要件の充足状況'));
  io.out(
    renderTable(
      ['項目', '状態'],
      [
        ['取引年月日', statusMark(capability.searchableFields.includes('transactionDate'))],
        ['取引金額', statusMark(capability.searchableFields.includes('amount'))],
        ['取引先', statusMark(capability.searchableFields.includes('counterparty'))],
        ['日付の範囲指定', statusMark(capability.supportsDateRange)],
        ['金額の範囲指定', statusMark(capability.supportsAmountRange)],
        ['2項目以上の組み合わせ', capability.twoFieldCombinations.join(', ')],
        ['出力形式', capability.exportFormats.join(', ')],
        ['索引', capability.indexes.join(', ')],
      ],
    ),
  );
  return EXIT_OK;
}

/** `synth` コマンド。 */
export async function commandSynth(args: ParsedArgs, io: CommandIo): Promise<number> {
  const module = await import('../cdk/synth.js');
  const snapshot = module.synthAll();
  const outDir = args.values['out'];
  if (outDir !== undefined) {
    const absolute = path.resolve(io.cwd, outDir);
    await mkdir(absolute, { recursive: true });
    const written: string[] = [];
    for (const [stackName, template] of Object.entries(snapshot.stacks)) {
      const file = path.join(absolute, `${stackName}.template.json`);
      await writeFile(file, `${JSON.stringify(template, null, 2)}\n`, 'utf8');
      written.push(file);
    }
    io.out(`CloudFormation テンプレートを ${written.length} 件書き出しました: ${absolute}`);
    for (const file of written) {
      io.out(`  ${path.basename(file)}`);
    }
    return EXIT_OK;
  }
  io.out(JSON.stringify(snapshot, null, 2));
  return EXIT_OK;
}

/** バルク取り込み用マニフェスト。 */
export interface BulkManifest {
  readonly baseDir?: string;
  readonly vouchers: readonly {
    readonly file: string;
    readonly voucherId: string;
    readonly transactionDate: string;
    readonly amountYen: number;
    readonly counterparty: { readonly name: string; readonly invoiceRegistrationNumber?: string };
    readonly documentType?: DocumentType;
    readonly mediaType?: string;
    readonly receivedAt?: string;
    readonly tags?: readonly string[];
    readonly note?: string;
  }[];
}

/** 拡張子から MIME タイプを推測する。 */
export function guessMediaType(fileName: string): string {
  const extension = path.extname(fileName).toLowerCase();
  const table: Record<string, string> = {
    '.pdf': 'application/pdf',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.csv': 'text/csv',
    '.json': 'application/json',
    '.txt': 'text/plain',
    '.xml': 'application/xml',
  };
  return table[extension] ?? 'application/octet-stream';
}

void isIsoDateInRange;
void ValidationError;
