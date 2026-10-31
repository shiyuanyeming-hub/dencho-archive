/**
 * 税務調査の「ダウンロードの求め」に応える出力（CSV / JSON）。
 *
 * 電帳法では、税務職員からダウンロードの求めがあったときに、保存した
 * 証憑の情報を電子的に渡せる必要がある。そのため出力は次の性質を持つ:
 *
 * - **CSV は UTF-8 BOM 付き・CRLF・RFC4180 準拠**: Excel で開いても文字化けせず、
 *   取引先名にカンマ・引用符・改行が含まれても列が壊れない。
 * - **ヘッダは日本語**: 税務調査の担当者がそのまま読める列名にする。
 * - **JSON は非機密フィールドのみ**: 内部の保存キーや検索用正規化キー、
 *   台帳内部のハッシュは含めない。機械可読な列挙値で出す。
 * - **決定的**: 同じ入力からは常に同じバイト列を返す（監査証跡として比較できる）。
 *
 * 登録番号（適格請求書発行事業者）は `StoredVoucher` が保持しないため、
 * 現時点では空欄を出力する（型を拡張する際の拡張ポイント）。
 */

import type {
  DocumentType,
  ExportFormat,
  ExportResult,
  IsoInstant,
  StoredVoucher,
  TimestampToken,
} from './types.js';
import { ValidationError } from './errors.js';
import { isValidIsoInstant } from './time.js';

// ---------------------------------------------------------------------------
// 定数
// ---------------------------------------------------------------------------

/** CSV の日本語ヘッダ（列順はこの順序を正とする）。 */
const CSV_COLUMNS: readonly string[] = [
  '取引年月日',
  '取引金額',
  '取引先',
  '書類種別',
  '証憑ID',
  'ファイル名',
  '登録番号',
  '保存時刻',
  '証憑ハッシュ',
  'タイムスタンプ',
];

/** `DocumentType` の日本語表記（税務調査の担当者が読む列のため）。 */
const DOCUMENT_TYPE_LABELS: Readonly<Record<DocumentType, string>> = {
  invoice: '請求書',
  receipt: '領収書',
  'delivery-note': '納品書',
  contract: '契約書',
  order: '注文書',
  statement: '明細書',
  other: 'その他',
};

/** UTF-8 BOM（Excel の文字化けを防ぐ）。 */
const UTF8_BOM = '\uFEFF';

/** CSV の改行（RFC4180）。 */
const CRLF = '\r\n';

/** CSV の MIME タイプ。 */
const CSV_MEDIA_TYPE = 'text/csv; charset=utf-8';

/** JSON の MIME タイプ。 */
const JSON_MEDIA_TYPE = 'application/json; charset=utf-8';

// ---------------------------------------------------------------------------
// 公開 API
// ---------------------------------------------------------------------------

/** `renderExport` の入力。 */
export interface ExportParams {
  /** 出力形式。 */
  readonly format: ExportFormat;
  /** 出力対象の証憑（検索結果など、呼び出し側が選んだもの）。 */
  readonly vouchers: readonly StoredVoucher[];
  /** アーカイブ ID。ファイル名と JSON のメタデータに含める。 */
  readonly archiveId: string;
  /** 出力を生成した時刻（オフセット付き RFC3339）。 */
  readonly generatedAt: IsoInstant;
}

/**
 * 証憑一覧を CSV または JSON へ変換する（純粋関数・決定的）。
 *
 * CSV の列は `CSV_COLUMNS` の 10 列。金額は円の整数（桁区切りなし）で出す。
 * 書類種別は日本語表記、保存時刻は台帳への記録時刻（JST の RFC3339）、
 * タイムスタンプ列にはトークンの生成時刻を入れる（未付与なら空欄）。
 * 登録番号は `StoredVoucher` が持たないため空欄となる。
 *
 * JSON は `{ schemaVersion: 1, archiveId, generatedAt, count, vouchers }` で、
 * 証憑ごとに voucherId / sequence / transactionDate / amountYen /
 * counterpartyName / documentType / originalFileName / mediaType /
 * contentSha256 / recordedAt / receivedAt / timestamp / tags のみを含める
 * （保存キー・正規化キー・台帳内部ハッシュ・自由記述メモは機密扱いで除外）。
 *
 * @throws ValidationError 形式が未対応、archiveId が空、generatedAt が不正な場合
 */
export function renderExport(params: ExportParams): ExportResult {
  if (params.archiveId.trim().length === 0) {
    throw new ValidationError('出力には archiveId が必要です');
  }
  if (!isValidIsoInstant(params.generatedAt)) {
    throw new ValidationError(
      `generatedAt が不正です（オフセット付き RFC3339 で指定）: ${params.generatedAt}`,
    );
  }

  switch (params.format) {
    case 'csv':
      return renderCsv(params);
    case 'json':
      return renderJson(params);
    default:
      // 型で網羅しているが、実行時の想定外入力（JSON 経由）も拒否する。
      throw new ValidationError(`未対応の出力形式です: ${String(params.format)}`);
  }
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

/** CSV を組み立てる（BOM + 日本語ヘッダ + RFC4180 のレコード）。 */
function renderCsv(params: ExportParams): ExportResult {
  const lines: string[] = [CSV_COLUMNS.map(escapeCsvCell).join(',')];
  for (const voucher of params.vouchers) {
    lines.push(csvVoucherRow(voucher).map(escapeCsvCell).join(','));
  }
  const text = `${UTF8_BOM}${lines.join(CRLF)}${CRLF}`;
  return {
    fileName: exportFileName('csv', params),
    mediaType: CSV_MEDIA_TYPE,
    bytes: new TextEncoder().encode(text),
    rowCount: params.vouchers.length,
  };
}

/** CSV の 1 レコード分（10 列）を組み立てる。 */
function csvVoucherRow(voucher: StoredVoucher): readonly string[] {
  return [
    voucher.transactionDate,
    String(voucher.amountYen),
    voucher.counterpartyName,
    DOCUMENT_TYPE_LABELS[voucher.documentType],
    voucher.voucherId,
    voucher.originalFileName,
    '', // 登録番号: StoredVoucher が保持しないため空欄（拡張ポイント）。
    voucher.recordedAt,
    voucher.contentSha256,
    voucher.timestamp === null ? '' : voucher.timestamp.generatedAt,
  ];
}

/**
 * RFC4180 のセルエスケープ。
 *
 * カンマ・引用符・CR・LF のいずれかを含む場合だけ引用符で囲み、
 * 内側の引用符は 2 つ重ねる。含まない場合は素のまま出す。
 */
function escapeCsvCell(value: string): string {
  if (!/[",\r\n]/u.test(value)) {
    return value;
  }
  return `"${value.replaceAll('"', '""')}"`;
}

// ---------------------------------------------------------------------------
// JSON
// ---------------------------------------------------------------------------

/** JSON に含める証憑（非機密フィールドのみ）。 */
interface ExportedVoucher {
  readonly voucherId: string;
  readonly sequence: number;
  readonly transactionDate: string;
  readonly amountYen: number;
  readonly counterpartyName: string;
  readonly documentType: DocumentType;
  readonly originalFileName: string;
  readonly mediaType: string;
  readonly contentSha256: string;
  readonly recordedAt: string;
  readonly receivedAt: string;
  readonly timestamp: TimestampToken | null;
  readonly tags: readonly string[];
}

/** JSON のトップレベル構造。 */
interface ExportedArchive {
  readonly schemaVersion: 1;
  readonly archiveId: string;
  readonly generatedAt: IsoInstant;
  readonly count: number;
  readonly vouchers: readonly ExportedVoucher[];
}

/** JSON を組み立てる（決定的なキー順・2 スペースインデント）。 */
function renderJson(params: ExportParams): ExportResult {
  const document: ExportedArchive = {
    schemaVersion: 1,
    archiveId: params.archiveId,
    generatedAt: params.generatedAt,
    count: params.vouchers.length,
    vouchers: params.vouchers.map(toExportedVoucher),
  };
  const text = `${JSON.stringify(document, null, 2)}\n`;
  return {
    fileName: exportFileName('json', params),
    mediaType: JSON_MEDIA_TYPE,
    bytes: new TextEncoder().encode(text),
    rowCount: params.vouchers.length,
  };
}

/** 保存済み証憑から、出力してよいフィールドだけを取り出す。 */
function toExportedVoucher(voucher: StoredVoucher): ExportedVoucher {
  return {
    voucherId: voucher.voucherId,
    sequence: voucher.sequence,
    transactionDate: voucher.transactionDate,
    amountYen: voucher.amountYen,
    counterpartyName: voucher.counterpartyName,
    documentType: voucher.documentType,
    originalFileName: voucher.originalFileName,
    mediaType: voucher.mediaType,
    contentSha256: voucher.contentSha256,
    recordedAt: voucher.recordedAt,
    receivedAt: voucher.receivedAt,
    timestamp: voucher.timestamp,
    tags: voucher.tags,
  };
}

// ---------------------------------------------------------------------------
// ファイル名
// ---------------------------------------------------------------------------

/**
 * 出力ファイル名を組み立てる（決定的）。
 *
 * 例: `dencho-arch-001-20261031T1830000900.csv`。
 * アーカイブ ID はファイル名に使える文字だけに落とし、
 * `generatedAt` は `-` `:` `+` を除いた時刻表記にする。
 */
function exportFileName(format: ExportFormat, params: ExportParams): string {
  const safeArchiveId = params.archiveId.replace(/[^A-Za-z0-9._-]/gu, '_');
  // ファイル名は UTC のコンパクト表記にする（JST の +09:00 を残すと
  // os によって不正な文字として扱われることがある）。
  const stamp = new Date(params.generatedAt)
    .toISOString()
    .replace(/[-:]/gu, '')
    .replace(/\.\d{3}Z$/u, 'Z');
  const extension = format === 'csv' ? 'csv' : 'json';
  return `dencho-${safeArchiveId}-${stamp}.${extension}`;
}
