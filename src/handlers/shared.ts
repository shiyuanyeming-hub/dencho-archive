/**
 * Lambda ハンドラの共通処理。
 *
 * イベントの検証・エラー応答の整形・構造化ログをここへ集約する。
 * ハンドラ本体は「入力を受けてアーカイブを呼び、結果を返す」だけにする。
 */
import type { Archive } from '../core/types.js';
import { getAwsArchive } from '../app/aws-factory.js';

/** Lambda のレスポンス形式（API Gateway / 直接呼び出しの両対応）。 */
export interface HandlerResponse {
  readonly statusCode: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

/** 構造化ログを 1 行で出す（CloudWatch Logs Insights で検索できる）。 */
export function logEvent(level: 'info' | 'warn' | 'error', message: string, fields: Record<string, unknown> = {}): void {
  const record = { level, message, timestamp: new Date().toISOString(), ...fields };
  const line = JSON.stringify(record);
  if (level === 'error') {
    console.error(line);
  } else {
    console.log(line);
  }
}

/** JSON 応答を作る。 */
export function jsonResponse(statusCode: number, body: unknown): HandlerResponse {
  return {
    statusCode,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
  };
}

/** エラーを HTTP ステータスへ変換する。 */
export function errorResponse(error: unknown): HandlerResponse {
  const name = error instanceof Error ? error.name : 'Error';
  const message = error instanceof Error ? error.message : String(error);
  switch (name) {
    case 'ValidationError':
      return jsonResponse(400, { ok: false, error: 'VALIDATION', message });
    case 'ConflictError':
    case 'ChainConflictError':
      return jsonResponse(409, { ok: false, error: 'CONFLICT', message });
    case 'NotFoundError':
      return jsonResponse(404, { ok: false, error: 'NOT_FOUND', message });
    case 'IntegrityError':
      return jsonResponse(500, { ok: false, error: 'INTEGRITY', message });
    default:
      return jsonResponse(500, { ok: false, error: 'INTERNAL', message });
  }
}

/** イベントをオブジェクトとして取り出す。 */
export function parseEventBody(event: unknown): Record<string, unknown> {
  if (typeof event === 'string') {
    return JSON.parse(event) as Record<string, unknown>;
  }
  if (typeof event === 'object' && event !== null && 'body' in event) {
    const body = (event as { body?: unknown }).body;
    if (typeof body === 'string') {
      return JSON.parse(body) as Record<string, unknown>;
    }
    if (typeof body === 'object' && body !== null) {
      return body as Record<string, unknown>;
    }
  }
  if (typeof event === 'object' && event !== null) {
    return event as Record<string, unknown>;
  }
  throw new Error('イベントの形式が不正です');
}

/** アーカイブを取り出す（テストでは差し替えられるよう引数で受ける）。 */
export function resolveArchive(override?: Archive): Archive {
  return override ?? getAwsArchive();
}
