/**
 * 出力 Lambda ハンドラ（税務調査の「ダウンロードの求め」対応）。
 *
 * 検索条件を指定して CSV / JSON を生成し、base64 で返す。
 * 呼び出し元（経理担当者・税務調査対応者）は、そのまま保存・提出できる。
 */
import { ValidationError } from '../core/errors.js';
import type { Archive, ExportFormat, VoucherQuery } from '../core/types.js';
import {
  errorResponse,
  jsonResponse,
  logEvent,
  parseEventBody,
  resolveArchive,
  type HandlerResponse,
} from './shared.js';

/** ハンドラ本体。 */
export async function handleExport(event: unknown, archive?: Archive): Promise<HandlerResponse> {
  try {
    const body = parseEventBody(event);
    const instance = resolveArchive(archive);
    const format = body['format'];
    if (format !== 'csv' && format !== 'json') {
      throw new ValidationError('format は csv か json を指定してください');
    }
    const query = (typeof body['query'] === 'object' && body['query'] !== null
      ? body['query']
      : {}) as VoucherQuery;
    const result = await instance.export({ format: format as ExportFormat, query });
    logEvent('info', 'export generated', { format, rowCount: result.rowCount, bytes: result.bytes.byteLength });
    return jsonResponse(200, {
      ok: true,
      fileName: result.fileName,
      mediaType: result.mediaType,
      rowCount: result.rowCount,
      contentBase64: Buffer.from(result.bytes).toString('base64'),
    });
  } catch (error) {
    logEvent('error', 'export failed', {
      cause: error instanceof Error ? error.message : String(error),
    });
    return errorResponse(error);
  }
}

/** Lambda エントリポイント。 */
export const handler = async (event: unknown): Promise<HandlerResponse> => handleExport(event);
