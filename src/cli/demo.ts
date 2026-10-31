/**
 * デモ: 一連の流れを実際に動かして見せる。
 *
 * 「取り込み → 検索 → 出力 → 検証 → 改ざん検知 → 適合性監査」を
 * ローカルだけで完結させる。AWS の資格情報は不要。
 *
 * 改ざん検知は、保存済みの証憑データを直接書き換えて再検証することで示す。
 * 実際の WORM（S3 Object Lock）環境では上書き自体が拒否されるが、
 * ローカルデモでは「もし破られたとしても検知できる」ことを確認する。
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Archive, DocumentType, InfraSnapshot } from '../core/types.js';
import { formatIsoInstant } from '../core/time.js';
import { createLocalArchive, localArchiveLayout } from '../app/factory.js';
import { DEFAULT_ARCHIVE_CONFIG } from '../app/metadata.js';
import { objectKeyFor } from '../core/hash.js';
import { formatBytes, formatYen, heading, oneLine, padDisplay, renderTable, statusMark } from './format.js';

/** デモで使う証憑のサンプル。 */
interface SampleVoucher {
  readonly voucherId: string;
  readonly transactionDate: string;
  readonly amountYen: number;
  readonly counterpartyName: string;
  readonly registration?: string;
  readonly documentType: DocumentType;
  readonly fileName: string;
  readonly receivedAt: string;
  readonly body: string;
}

/** デモ用の証憑（実在の企業名ではなく架空のもの）。 */
export const SAMPLE_VOUCHERS: readonly SampleVoucher[] = [
  {
    voucherId: 'INV-2026-0415-001',
    transactionDate: '2026-04-15',
    amountYen: 330_000,
    counterpartyName: '株式会社サンプル商事',
    registration: 'T1234567890123',
    documentType: 'invoice',
    fileName: 'invoice-2026-04-15.pdf',
    receivedAt: '2026-04-16T10:00:00+09:00',
    body: '%PDF-1.4\n請求書\n株式会社サンプル商事\n合計 330,000 円（税込）\n',
  },
  {
    voucherId: 'RCP-2026-0502-014',
    transactionDate: '2026-05-02',
    amountYen: 8_800,
    counterpartyName: '有限会社テスト工業',
    documentType: 'receipt',
    fileName: 'receipt-2026-05-02.pdf',
    receivedAt: '2026-05-03T09:30:00+09:00',
    body: '%PDF-1.4\n領収書\n有限会社テスト工業\n8,800 円\n',
  },
  {
    // 1 社目と表記ゆれ（(株) 表記）を持つ取引先。検索の正規化で同一視できることを示す。
    voucherId: 'INV-2026-0611-007',
    transactionDate: '2026-06-11',
    amountYen: 275_000,
    counterpartyName: 'サンプル商事(株)',
    documentType: 'invoice',
    fileName: 'invoice-2026-06-11.pdf',
    receivedAt: '2026-06-12T11:15:00+09:00',
    body: '%PDF-1.4\n請求書\nサンプル商事(株)\n275,000 円\n',
  },
  {
    voucherId: 'DN-2026-0620-003',
    transactionDate: '2026-06-20',
    amountYen: 1_250_000,
    counterpartyName: '株式会社デモ電機',
    registration: 'T9876543210987',
    documentType: 'delivery-note',
    fileName: 'delivery-2026-06-20.pdf',
    receivedAt: '2026-06-21T15:45:00+09:00',
    body: '%PDF-1.4\n納品書\n株式会社デモ電機\n1,250,000 円\n',
  },
  {
    voucherId: 'CTR-2026-0701-002',
    transactionDate: '2026-07-01',
    amountYen: 500_000,
    counterpartyName: '合同会社クラウドデモ',
    registration: 'T1111222233334',
    documentType: 'contract',
    fileName: 'contract-2026-07-01.pdf',
    receivedAt: '2026-07-02T13:00:00+09:00',
    body: '%PDF-1.4\n業務委託契約書\n合同会社クラウドデモ\n500,000 円\n',
  },
];

/** デモの基準時刻（出力を再現可能にするため固定する）。 */
export const DEMO_NOW = '2026-07-10T09:00:00+09:00';

export interface DemoOptions {
  /** 作業ディレクトリ。 */
  readonly dir: string;
  /** 終了後にディレクトリを残すか。 */
  readonly keep?: boolean;
  readonly write?: (line: string) => void;
}

/** デモを実行する。戻り値は CLI の終了コード。 */
export async function runDemo(options: DemoOptions): Promise<number> {
  const write = options.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const layout = localArchiveLayout(options.dir);
  const clock = new DemoClock(DEMO_NOW);

  write(`デモ用ディレクトリ: ${layout.rootDir}`);
  write('（固定時刻で実行するため、出力は毎回同じになります）');

  const archive = await createLocalArchive({
    rootDir: layout.rootDir,
    archiveId: 'demo-archive',
    reset: true,
    clock,
    createdAt: DEMO_NOW,
    config: { ...DEFAULT_ARCHIVE_CONFIG },
  });

  // ---------------------------------------------------------------------
  write(heading('1. 証憑を取り込む（タイムスタンプを付与し、チェーンへ追記）'));
  const ingestRows: string[][] = [];
  for (const sample of SAMPLE_VOUCHERS) {
    // 取り込みは「受領の翌営業日」に行われた想定にする。
    // これによりタイムスタンプの付与期限（受領から 62 日以内）を満たす。
    clock.setTo(shiftDays(sample.receivedAt, 1));
    const bytes = new TextEncoder().encode(sample.body);
    const result = await archive.ingest({
      voucherId: sample.voucherId,
      transactionDate: sample.transactionDate,
      amountYen: sample.amountYen,
      counterparty: {
        name: sample.counterpartyName,
        ...(sample.registration === undefined ? {} : { invoiceRegistrationNumber: sample.registration }),
      },
      documentType: sample.documentType,
      originalFileName: sample.fileName,
      mediaType: 'application/pdf',
      content: bytes,
      receivedAt: sample.receivedAt,
    });
    ingestRows.push([
      String(result.voucher.sequence),
      result.voucher.voucherId,
      result.voucher.transactionDate,
      formatYen(result.voucher.amountYen),
      result.voucher.counterpartyName,
      `${formatBytes(bytes.byteLength)}`,
      result.voucher.timestamp === null ? 'なし' : '付与済み',
    ]);
  }
  write(
    renderTable(
      ['#', '証憑ID', '取引年月日', '金額', '取引先', 'サイズ', 'タイムスタンプ'],
      ingestRows,
    ),
  );

  // 冪等性の確認
  const duplicate = await archive.ingest({
    voucherId: SAMPLE_VOUCHERS[0]?.voucherId ?? '',
    transactionDate: SAMPLE_VOUCHERS[0]?.transactionDate ?? '',
    amountYen: SAMPLE_VOUCHERS[0]?.amountYen ?? 0,
    counterparty: { name: SAMPLE_VOUCHERS[0]?.counterpartyName ?? '' },
    documentType: 'invoice',
    originalFileName: SAMPLE_VOUCHERS[0]?.fileName ?? '',
    mediaType: 'application/pdf',
    content: new TextEncoder().encode(SAMPLE_VOUCHERS[0]?.body ?? ''),
    receivedAt: SAMPLE_VOUCHERS[0]?.receivedAt ?? DEMO_NOW,
  });
  write(`\n同じデータの再送: ${duplicate.idempotent ? '冪等（二重登録しない）' : '新規登録'} — 台帳は ${await entryCount(archive)} 件のまま`);

  // ---------------------------------------------------------------------
  write(heading('2. 検索要件（取引年月日・金額・取引先）で検索する'));

  const byDate = await archive.search({ dateFrom: '2026-04-01', dateTo: '2026-06-30' });
  write(`\n[a] 取引年月日 2026-04-01 〜 2026-06-30 → ${byDate.length} 件`);
  write(renderVoucherTable(byDate));

  const byAmount = await archive.search({ amountMin: 100_000, amountMax: 400_000 });
  write(`\n[b] 取引金額 ¥100,000 〜 ¥400,000 → ${byAmount.length} 件`);
  write(renderVoucherTable(byAmount));

  const byCounterparty = await archive.search({ counterparty: 'サンプル商事' });
  write(`\n[c] 取引先「サンプル商事」（表記ゆれを吸収） → ${byCounterparty.length} 件`);
  write(renderVoucherTable(byCounterparty));
  write('    「株式会社サンプル商事」と「サンプル商事(株)」が同じ取引先として一致しています。');

  const combined = await archive.search({
    counterparty: 'サンプル商事',
    amountMin: 300_000,
    dateFrom: '2026-01-01',
    dateTo: '2026-12-31',
  });
  write(`\n[d] 取引先 + 金額範囲 + 日付範囲の組み合わせ → ${combined.length} 件`);
  write(renderVoucherTable(combined));

  const plan = archive.plan({ counterparty: 'サンプル商事', dateFrom: '2026-04-01', dateTo: '2026-06-30' });
  write(`\n検索計画: ${plan.rationale}`);
  write(
    `  索引アクセス: ${plan.estimatedAccesses} 回（${plan.accesses.map((access) => `${access.index}[${access.partitionKey}]`).join(', ')}）`,
  );

  // ---------------------------------------------------------------------
  write(heading('3. 税務調査の「ダウンロードの求め」に備えて出力する'));
  const exported = await archive.export({
    format: 'csv',
    query: { dateFrom: '2026-04-01', dateTo: '2026-12-31' },
  });
  const csvText = new TextDecoder('utf-8').decode(exported.bytes);
  const csvLines = csvText.split('\r\n').slice(0, 4);
  write(`\n${exported.fileName}（${formatBytes(exported.bytes.byteLength)} / ${exported.rowCount} 行）`);
  write(csvLines.join('\n'));
  write('  …');
  write(`  先頭に UTF-8 BOM（${exported.bytes[0] === 0xef ? 'あり' : 'なし'}）を付け、Excel で文字化けしないようにしています。`);

  // ---------------------------------------------------------------------
  write(heading('4. ハッシュチェーンを検証し、適合性を監査する'));
  const intact = await archive.verifyChain();
  write(`\n状態: ${intact.status} / 検証したエントリ: ${intact.checkedEntries} 件`);
  write(`先頭ハッシュ: ${intact.headHash?.slice(0, 16) ?? '(空)'}…`);
  write(`チェックポイント検証: ${intact.checkpointsVerified ? 'OK' : 'NG'}`);

  const cleanReport = await archive.audit(await trySynthInfra().then((infra) => (infra === undefined ? {} : { infra })));
  const cleanLabel = cleanReport.verdict === 'compliant' ? '適合' : '不適合';
  write(
    `\n（改ざん前の監査）総合判定: ${cleanLabel}` +
      `（pass ${cleanReport.summary.passed} / fail ${cleanReport.summary.failed} / n/a ${cleanReport.summary.notApplicable}）`,
  );

  // ---------------------------------------------------------------------
  write(heading('5. 保存データを 1 バイトだけ改ざんして、検知できるか確かめる'));
  const target = await archive.search({ dateFrom: '2026-06-01', dateTo: '2026-06-15' });
  const victim = target[0];
  const blobPath = path.join(layout.blobsDir, objectKeyFor(victim?.contentSha256 ?? ''));
  const original = await readFile(blobPath);
  const tampered = new Uint8Array(original);
  const markerIndex = tampered.findIndex((byte) => byte === 0x31); // '1' を探す
  if (markerIndex >= 0) {
    tampered[markerIndex] = 0x32; // '1' → '2' に差し替える
  }
  await writeFile(blobPath, tampered);
  write(`\n改ざん: ${victim?.voucherId ?? '?'} の本体 1 バイトを書き換えました`);
  write(`  対象: ${path.relative(layout.rootDir, blobPath)}`);

  const broken = await archive.verifyChain();
  write(`\n再検証の結果: ${statusMark(broken.status === 'intact')} ${broken.status}`);
  if (broken.break !== undefined) {
    write(`  検出位置: 第 ${broken.break.sequence} 項（${broken.break.voucherId}）`);
    write(`  理由: ${broken.break.reason}`);
    write(`  期待: ${broken.break.expected.slice(0, 16)}…`);
    write(`  実際: ${broken.break.actual.slice(0, 16)}…`);
  }

  // ---------------------------------------------------------------------
  write(heading('6. 電帳法の適合性を監査する'));
  const infra = await trySynthInfra();
  const report = await archive.audit(infra === undefined ? {} : { infra });
  const counts = report.summary;
  write(
    `\n総合判定: ${report.verdict === 'compliant' ? '適合' : report.verdict === 'incomplete' ? '判定不能' : '不適合'}` +
      ` （pass ${counts.passed} / fail ${counts.failed} / n/a ${counts.notApplicable}${counts.errored > 0 ? ` / error ${counts.errored}` : ''}）`,
  );
  write(`監査対象: 証憑 ${report.scope.vouchers} 件 / インフラ ${report.scope.infraStacks} スタック`);
  const failed = report.results.filter((result) => result.status === 'fail');
  if (failed.length === 0) {
    write('失敗した必須ルールはありません。');
  } else {
    write('\n失敗したルール:');
    for (const result of failed) {
      write(`  ${statusMark(false)} ${result.ruleId} ${result.title}`);
      for (const evidence of result.evidence.slice(0, 2)) {
        write(`      - ${oneLine(evidence.detail, 80)}`);
      }
      if (result.remediation !== undefined) {
        write(`      → ${oneLine(result.remediation, 80)}`);
      }
    }
  }

  // ---------------------------------------------------------------------
  write(heading('まとめ'));
  write('  取り込み・検索・出力・検証・監査を、AWS なしでローカルだけで再現しました。');
  write('  同じアプリケーションコードが Lambda 上でも動きます（ポート & アダプタ）。');
  write('  採用した設計と、電帳法の要件との対応は docs/COMPLIANCE_MAPPING.ja.md を参照してください。');

  if (options.keep !== true) {
    write(`\n（次回実行時に作り直すため、デモ用データは ${layout.rootDir} に残しています）`);
  }

  return 0;
}

/** デモ用に時刻を固定しつつ、必要な場面で進められるクロック。 */
class DemoClock {
  private current: Date;
  constructor(instant: string) {
    this.current = new Date(instant);
  }
  now(): Date {
    return new Date(this.current.getTime());
  }
  setTo(instant: string): void {
    this.current = new Date(instant);
  }
}

function renderVoucherTable(vouchers: readonly { voucherId: string; transactionDate: string; amountYen: number; counterpartyName: string }[]): string {
  if (vouchers.length === 0) {
    return '   （該当なし）';
  }
  const rows = vouchers.map((voucher) => [
    voucher.voucherId,
    voucher.transactionDate,
    formatYen(voucher.amountYen),
    voucher.counterpartyName,
  ]);
  return renderTable(['証憑ID', '取引年月日', '金額', '取引先'], rows);
}

async function entryCount(archive: Archive): Promise<number> {
  return (await archive.list()).length;
}

/** CDK の合成結果を取得する。合成できない場合（未ビルド等）は undefined。 */
async function trySynthInfra(): Promise<InfraSnapshot | undefined> {
  try {
    const module = await import('../cdk/synth.js');
    return module.synthAll();
  } catch {
    return undefined;
  }
}

/** ISO 時刻を日数だけずらす。 */
function shiftDays(instant: string, days: number): string {
  const shifted = new Date(new Date(instant).getTime() + days * 86_400_000);
  return formatIsoInstant(shifted);
}

/** デモで使うパディング補助（外部から使う場合のため）。 */
export const demoPad = padDisplay;

/** 保存済みオブジェクトのパスを返す（デモ・検証用）。 */
export function blobPathOf(rootDir: string, objectKey: string): string {
  return path.join(localArchiveLayout(rootDir).blobsDir, objectKey);
}
