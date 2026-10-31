/**
 * 証憑メタデータの検証と組み立て。
 *
 * 電帳法の検索要件は「取引年月日・取引金額・取引先」で検索できることを
 * 求めるため、これらは取り込み時点で必ず存在し、正規化されている必要がある。
 * 不正なデータを後から直すことはできない（WORM 前提）ので、
 * 入口で厳しく検証する。
 */
import type {
  ArchiveConfig,
  LedgerEntry,
  StoredMetadata,
  StoredVoucher,
  VoucherInput,
  VoucherMetadata,
} from '../core/types.js';
import { ValidationError } from '../core/errors.js';
import { formatIsoInstant, isValidIsoDate, isValidIsoInstant, parseIsoInstant } from '../core/time.js';
import { normalizeCounterparty } from '../core/index-keys.js';

/** 証憑データ 1 件あたりの上限（10 MiB）。Lambda のペイロード制限より十分小さい。 */
export const MAX_CONTENT_BYTES = 10 * 1024 * 1024;

/** 識別子の最大長。 */
export const MAX_ID_LENGTH = 128;

/** 金額の上限（円）。11 桁まで（100 億円）。 */
export const MAX_AMOUNT_YEN = 99_999_999_999;

/** 既定のアーカイブ設定。 */
export const DEFAULT_ARCHIVE_CONFIG: Omit<ArchiveConfig, 'archiveId'> = {
  retentionYears: 7,
  timestampMaxDelayDays: 62,
  worm: false,
  requireTimestamp: true,
};

/** 設定の妥当性を検証する。 */
export function validateArchiveConfig(config: ArchiveConfig): void {
  if (config.archiveId.trim().length === 0) {
    throw new ValidationError('archiveId は必須です');
  }
  if (!Number.isInteger(config.retentionYears) || config.retentionYears < 1) {
    throw new ValidationError('retentionYears は 1 以上の整数で指定してください');
  }
  if (!Number.isInteger(config.timestampMaxDelayDays) || config.timestampMaxDelayDays < 0) {
    throw new ValidationError('timestampMaxDelayDays は 0 以上の整数で指定してください');
  }
}

/** 制御文字を含まないかを確認する（ログ・CSV への注入を防ぐ）。 */
function hasControlCharacters(value: string): boolean {
  // 改行・タブは CSV エスケープで扱えるため許可し、その他の制御文字を拒否する。
  // eslint-disable-next-line no-control-regex
  return /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value);
}

/** 文字列フィールドの共通検証。 */
function requireText(value: string, field: string, maxLength: number): string {
  if (typeof value !== 'string') {
    throw new ValidationError(`${field} は文字列で指定してください`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new ValidationError(`${field} は必須です`);
  }
  if (trimmed.length > maxLength) {
    throw new ValidationError(`${field} が長すぎます（最大 ${maxLength} 文字）`, { field, length: trimmed.length });
  }
  if (hasControlCharacters(trimmed)) {
    throw new ValidationError(`${field} に制御文字が含まれています`);
  }
  return trimmed;
}

/**
 * 取り込み入力を検証する。
 *
 * 時刻の比較に `now` を使うため、呼び出し側が現在時刻を渡す。
 * 受領時刻が未来すぎるデータは、取引日との整合が取れないため拒否する。
 */
export function validateVoucherInput(input: VoucherInput, now: Date): void {
  requireText(input.voucherId, 'voucherId', MAX_ID_LENGTH);

  if (!isValidIsoDate(input.transactionDate)) {
    throw new ValidationError(
      'transactionDate は JST の日付（YYYY-MM-DD）で指定してください',
      { transactionDate: input.transactionDate },
    );
  }

  if (!Number.isInteger(input.amountYen)) {
    throw new ValidationError('amountYen は整数（円）で指定してください', { amountYen: input.amountYen });
  }
  if (input.amountYen < 0) {
    throw new ValidationError('amountYen に負の値は指定できません', { amountYen: input.amountYen });
  }
  if (input.amountYen > MAX_AMOUNT_YEN) {
    throw new ValidationError('amountYen が上限を超えています', { amountYen: input.amountYen });
  }

  requireText(input.counterparty.name, 'counterparty.name', 200);

  if (input.counterparty.invoiceRegistrationNumber !== undefined) {
    const registration = input.counterparty.invoiceRegistrationNumber.trim();
    if (!/^T\d{13}$/.test(registration)) {
      throw new ValidationError(
        'invoiceRegistrationNumber は T + 13 桁の数字で指定してください（インボイス制度の登録番号）',
        { invoiceRegistrationNumber: input.counterparty.invoiceRegistrationNumber },
      );
    }
  }

  requireText(input.originalFileName, 'originalFileName', 255);
  if (/[/\\]/.test(input.originalFileName) || input.originalFileName === '.' || input.originalFileName === '..') {
    throw new ValidationError('originalFileName にパスを含めないでください（ファイル名のみ）', {
      originalFileName: input.originalFileName,
    });
  }

  requireText(input.mediaType, 'mediaType', 128);
  if (!/^[a-z]+\/[A-Za-z0-9.+-]+$/.test(input.mediaType)) {
    throw new ValidationError('mediaType は MIME タイプ形式（例: application/pdf）で指定してください', {
      mediaType: input.mediaType,
    });
  }

  if (!(input.content instanceof Uint8Array)) {
    throw new ValidationError('content は Uint8Array で指定してください');
  }
  if (input.content.byteLength === 0) {
    throw new ValidationError('content が空です');
  }
  if (input.content.byteLength > MAX_CONTENT_BYTES) {
    throw new ValidationError('content が大きすぎます', { bytes: input.content.byteLength, max: MAX_CONTENT_BYTES });
  }

  if (!isValidIsoInstant(input.receivedAt)) {
    throw new ValidationError('receivedAt はオフセット付き RFC3339 で指定してください', {
      // 記録は秒精度に揃える（タイムスタンプの時刻と比較可能にするため）。
    receivedAt: formatIsoInstant(parseIsoInstant(input.receivedAt)),
    });
  }
  const receivedAt = parseIsoInstant(input.receivedAt);
  // 受領時刻が未来になるのは時計ずれ以外にありえない。1 分のずれは許容するが、
  // それを超える未来時刻は拒否する（タイムスタンプより前に受領した、という
  // 矛盾した記録を作らないため）。
  const clockSkewMs = 60 * 1000;
  if (receivedAt.getTime() > now.getTime() + clockSkewMs) {
    throw new ValidationError('receivedAt が未来の時刻です（時計ずれの可能性を確認してください）', {
      // 記録は秒精度に揃える（タイムスタンプの時刻と比較可能にするため）。
    receivedAt: formatIsoInstant(parseIsoInstant(input.receivedAt)),
      now: now.toISOString(),
    });
  }

  if (input.tags !== undefined) {
    if (input.tags.length > 20) {
      throw new ValidationError('tags は 20 件までです');
    }
    for (const tag of input.tags) {
      requireText(tag, 'tags[]', 50);
    }
  }

  if (input.note !== undefined && input.note.length > 1000) {
    throw new ValidationError('note は 1000 文字までです');
  }
}

/** 検証済みの入力から、保存するメタデータを組み立てる。 */
export function buildVoucherMetadata(input: VoucherInput, contentSha256: string): VoucherMetadata {
  const registration = input.counterparty.invoiceRegistrationNumber?.trim();
  return {
    schemaVersion: 1,
    voucherId: input.voucherId.trim(),
    transactionDate: input.transactionDate,
    amountYen: input.amountYen,
    counterpartyName: input.counterparty.name.trim(),
    counterpartyNormalized: normalizeCounterparty(input.counterparty.name),
    invoiceRegistrationNumber: registration === undefined || registration === '' ? null : registration,
    documentType: input.documentType,
    originalFileName: input.originalFileName.trim(),
    mediaType: input.mediaType.trim(),
    contentSha256,
    contentBytes: input.content.byteLength,
    // 記録は秒精度に揃える（タイムスタンプの時刻と比較可能にするため）。
    receivedAt: formatIsoInstant(parseIsoInstant(input.receivedAt)),
    tags: [...(input.tags ?? [])].map((tag) => tag.trim()),
    note: input.note?.trim() === undefined || input.note.trim() === '' ? null : input.note.trim(),
  };
}

/** 台帳エントリとメタデータ封筒から、公開ビューを作る。 */
export function toStoredVoucher(entry: LedgerEntry, envelope: StoredMetadata): StoredVoucher {
  const { metadata } = envelope;
  return {
    voucherId: entry.voucherId,
    sequence: entry.sequence,
    transactionDate: metadata.transactionDate,
    amountYen: metadata.amountYen,
    counterpartyName: metadata.counterpartyName,
    counterpartyNormalized: metadata.counterpartyNormalized,
    documentType: metadata.documentType,
    originalFileName: metadata.originalFileName,
    mediaType: metadata.mediaType,
    objectKey: entry.objectKey,
    contentSha256: entry.contentSha256,
    metadataSha256: entry.metadataSha256,
    entryHash: entry.entryHash,
    recordedAt: entry.recordedAt,
    receivedAt: metadata.receivedAt,
    timestamp: envelope.timestamp,
    tags: metadata.tags,
    note: metadata.note,
  };
}
