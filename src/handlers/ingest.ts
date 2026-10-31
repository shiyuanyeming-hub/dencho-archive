/**
 * 取り込み Lambda ハンドラ。
 *
 * 証憑データは base64 で受け取り、アーカイブへ保存する。
 * 冪等性は voucherId で担保されるため、SQS の再配信や
 * API のリトライで二重登録されることはない。
 */
import { ValidationError } from '../core/errors.js';
import type { Archive, DocumentType, VoucherInput } from '../core/types.js';
import {
  errorResponse,
  jsonResponse,
  logEvent,
  parseEventBody,
  resolveArchive,
  type HandlerResponse,
} from './shared.js';

/** ハンドラ本体（テストから直接呼べるように分離）。 */
export async function handleIngest(event: unknown, archive?: Archive): Promise<HandlerResponse> {
  try {
    const body = parseEventBody(event);
    const input = toVoucherInput(body);
    const result = await resolveArchive(archive).ingest(input);
    logEvent('info', 'voucher ingested', {
      voucherId: result.voucher.voucherId,
      sequence: result.voucher.sequence,
      idempotent: result.idempotent,
      contentSha256: result.voucher.contentSha256,
    });
    return jsonResponse(result.idempotent ? 200 : 201, {
      ok: true,
      idempotent: result.idempotent,
      voucher: {
        voucherId: result.voucher.voucherId,
        sequence: result.voucher.sequence,
        entryHash: result.voucher.entryHash,
        contentSha256: result.voucher.contentSha256,
        recordedAt: result.voucher.recordedAt,
        timestamp: result.voucher.timestamp,
      },
    });
  } catch (error) {
    logEvent('error', 'ingest failed', {
      cause: error instanceof Error ? error.message : String(error),
    });
    return errorResponse(error);
  }
}

/** Lambda エントリポイント。 */
export const handler = async (event: unknown): Promise<HandlerResponse> => handleIngest(event);

/** イベント本文を検証して入力へ変換する。 */
function toVoucherInput(body: Record<string, unknown>): VoucherInput {
  const contentBase64 = requireString(body, 'contentBase64');
  const content = Uint8Array.from(Buffer.from(contentBase64, 'base64'));
  const counterparty = body['counterparty'];
  if (typeof counterparty !== 'object' || counterparty === null) {
    throw new ValidationError('counterparty は { name } の形式で指定してください');
  }
  const counterpartyRecord = counterparty as Record<string, unknown>;
  const registration = counterpartyRecord['invoiceRegistrationNumber'];
  const tags = body['tags'];
  const note = body['note'];
  const receivedAt = body['receivedAt'];

  return {
    voucherId: requireString(body, 'voucherId'),
    transactionDate: requireString(body, 'transactionDate'),
    amountYen: requireNumber(body, 'amountYen'),
    counterparty: {
      name: requireString(counterpartyRecord, 'name'),
      ...(typeof registration === 'string' ? { invoiceRegistrationNumber: registration } : {}),
    },
    documentType: requireString(body, 'documentType') as DocumentType,
    originalFileName: requireString(body, 'originalFileName'),
    mediaType: requireString(body, 'mediaType'),
    content,
    receivedAt: typeof receivedAt === 'string' ? receivedAt : new Date().toISOString(),
    ...(Array.isArray(tags) ? { tags: tags.map((tag) => String(tag)) } : {}),
    ...(typeof note === 'string' ? { note } : {}),
  };
}

function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ValidationError(`${key} は必須です`);
  }
  return value;
}

function requireNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new ValidationError(`${key} は整数で指定してください`);
  }
  return value;
}
