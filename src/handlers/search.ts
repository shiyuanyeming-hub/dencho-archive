/**
 * 検索 Lambda ハンドラ。
 *
 * 取引年月日・金額・取引先（とその組み合わせ）で検索する。
 * 索引は DynamoDB にあるため、S3 を全件走査しない。
 */
import { ValidationError } from '../core/errors.js';
import type { Archive, DocumentType, VoucherQuery } from '../core/types.js';
import {
  errorResponse,
  jsonResponse,
  logEvent,
  parseEventBody,
  resolveArchive,
  type HandlerResponse,
} from './shared.js';

/** ハンドラ本体。 */
export async function handleSearch(event: unknown, archive?: Archive): Promise<HandlerResponse> {
  try {
    const body = parseEventBody(event);
    const instance = resolveArchive(archive);
    const query = toQuery(body);
    const vouchers = await instance.search(query);
    const plan = instance.plan(query);
    logEvent('info', 'voucher search', { count: vouchers.length, indexes: plan.accesses.map((access) => access.index) });
    return jsonResponse(200, {
      ok: true,
      count: vouchers.length,
      plan: { accesses: plan.accesses, estimatedAccesses: plan.estimatedAccesses, rationale: plan.rationale },
      vouchers,
    });
  } catch (error) {
    logEvent('error', 'search failed', {
      cause: error instanceof Error ? error.message : String(error),
    });
    return errorResponse(error);
  }
}

/** Lambda エントリポイント。 */
export const handler = async (event: unknown): Promise<HandlerResponse> => handleSearch(event);

/** イベント本文から検索条件を作る（`query` 配下でも直下でもよい）。 */
function toQuery(body: Record<string, unknown>): VoucherQuery {
  const raw = typeof body['query'] === 'object' && body['query'] !== null ? (body['query'] as Record<string, unknown>) : body;
  const query: Mutable<VoucherQuery> = {};
  const dateFrom = raw['dateFrom'];
  const dateTo = raw['dateTo'];
  const amountMin = raw['amountMin'];
  const amountMax = raw['amountMax'];
  const counterparty = raw['counterparty'];
  const documentType = raw['documentType'];
  const limit = raw['limit'];

  if (typeof dateFrom === 'string') query.dateFrom = dateFrom;
  if (typeof dateTo === 'string') query.dateTo = dateTo;
  if (typeof amountMin === 'number') query.amountMin = amountMin;
  if (typeof amountMax === 'number') query.amountMax = amountMax;
  if (typeof counterparty === 'string') query.counterparty = counterparty;
  if (typeof documentType === 'string') query.documentType = documentType as DocumentType;
  if (typeof limit === 'number') query.limit = limit;

  if (Object.keys(query).length === 0) {
    throw new ValidationError('検索条件を 1 つ以上指定してください');
  }
  return query;
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
