/**
 * 整合性検証 Lambda ハンドラ。
 *
 * EventBridge の日次スケジュールから呼ばれ、台帳全体のハッシュチェーンを
 * 検証する。破損を検知したら CloudWatch のカスタムメトリクス
 * `DenchoArchive/ChainVerificationFailure` を発行し、アラームで通知する。
 *
 * CloudWatch の埋め込みメトリクス形式（EMF）を使うため、
 * `cloudwatch:PutMetricData` の権限は不要（ログから抽出される）。
 */
import type { Archive } from '../core/types.js';
import { jsonResponse, logEvent, resolveArchive, type HandlerResponse } from './shared.js';

/** メトリクスの名前空間。 */
export const METRIC_NAMESPACE = 'DenchoArchive';

/** ハンドラ本体。 */
export async function handleVerify(_event: unknown, archive?: Archive): Promise<HandlerResponse> {
  try {
    const instance = resolveArchive(archive);
    const result = await instance.verifyChain();
    const failed = result.status === 'broken' ? 1 : 0;
    emitMetric('ChainVerificationFailure', failed);
    emitMetric('ChainVerifiedEntries', result.checkedEntries);
    logEvent('info', 'chain verification', {
      status: result.status,
      checkedEntries: result.checkedEntries,
      headHash: result.headHash,
      breakReason: result.break?.reason ?? null,
    });
    return jsonResponse(result.status === 'broken' ? 500 : 200, {
      ok: result.status !== 'broken',
      status: result.status,
      checkedEntries: result.checkedEntries,
      headHash: result.headHash,
      checkpointsVerified: result.checkpointsVerified,
      break: result.break ?? null,
    });
  } catch (error) {
    emitMetric('ChainVerificationFailure', 1);
    logEvent('error', 'chain verification failed', {
      cause: error instanceof Error ? error.message : String(error),
    });
    return jsonResponse(500, { ok: false, error: 'INTERNAL', message: error instanceof Error ? error.message : String(error) });
  }
}

/** Lambda エントリポイント。 */
export const handler = async (_event: unknown): Promise<HandlerResponse> => handleVerify(_event);

/** CloudWatch 埋め込みメトリクス形式で 1 行出力する。 */
function emitMetric(name: string, value: number): void {
  const line = {
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [
        {
          Namespace: METRIC_NAMESPACE,
          Dimensions: [['Service']],
          Metrics: [{ Name: name, Unit: 'Count' }],
        },
      ],
    },
    Service: 'archive-verify',
    [name]: value,
  };
  console.log(JSON.stringify(line));
}
