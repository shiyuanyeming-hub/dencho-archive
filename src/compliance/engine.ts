/**
 * 適合性検証エンジン。
 *
 * `BUILTIN_RULES` を順番に評価して `RuleResult` の列へ合成し、
 * 監査レポート（`AuditReport`）を組み立てる。
 *
 * 設計方針:
 * - ルール 1 件の失敗（例外・不正な戻り値）で監査全体を落とさない。
 *   例外は `status: 'error'` と `error` メッセージに変換する。
 * - 出力順は `BUILTIN_RULES` の順序をそのまま保つ（決定的なレポート）。
 * - 総合判定は「必須ルールの fail」→ 不適合、「必須ルールの error」→ 判定不能、
 *   それ以外 → 適合。必須ルールの `not-applicable` は判定を妨げない。
 */
import type {
  AuditReport,
  AuditSummary,
  AuditVerdict,
  ComplianceRule,
  IsoInstant,
  RuleContext,
  RuleEvaluation,
  RuleResult,
} from '../core/types.js';
import { BUILTIN_RULES } from './rules/index.js';

/** 監査レポートを組み立てるための入力。 */
export interface BuildReportParams {
  /** アーカイブ ID。 */
  readonly archiveId: string;
  /** レポート生成時刻（JST の RFC3339）。 */
  readonly generatedAt: IsoInstant;
  /** 評価済みのルール結果（`BUILTIN_RULES` の順序を保つ）。 */
  readonly results: readonly RuleResult[];
  /** 監査の対象範囲（件数）。 */
  readonly scope: {
    /** 監査した証憑の件数。 */
    readonly vouchers: number;
    /** 監査したインフラスタックの数（インフラ未指定なら 0）。 */
    readonly infraStacks: number;
    /** 検証した台帳エントリの件数。 */
    readonly checkedEntries: number;
  };
}

/**
 * 任意のルール集合を順番に評価する。
 *
 * 公開 API の `evaluateRules` はこれをビルトインルールで呼ぶだけである。
 * ルール集合を差し替えられるようにしておくことで、エンジン単体の
 * 異常系（例外を投げるルール）をテストできる。
 */
export async function evaluateRuleSet(
  rules: readonly ComplianceRule[],
  context: RuleContext,
): Promise<readonly RuleResult[]> {
  const results: RuleResult[] = [];
  for (const rule of rules) {
    results.push(await evaluateOne(rule, context));
  }
  return results;
}

/**
 * ビルトインの適合性ルールを順番に評価する。
 *
 * どのルールが例外を投げてもこの関数は失敗しない（`status: 'error'` に変換する）。
 */
export async function evaluateRules(context: RuleContext): Promise<readonly RuleResult[]> {
  return evaluateRuleSet(BUILTIN_RULES, context);
}

/**
 * 評価結果から監査レポートを組み立てる。
 *
 * `results` の順序はそのまま保持する（呼び出し側で `BUILTIN_RULES` 順に
 * 並んでいる前提）。集計値と総合判定だけをここで導出する。
 */
export function buildAuditReport(params: BuildReportParams): AuditReport {
  return {
    schemaVersion: 1,
    archiveId: params.archiveId,
    generatedAt: params.generatedAt,
    verdict: decideVerdict(params.results),
    summary: summarize(params.results),
    scope: {
      vouchers: params.scope.vouchers,
      infraStacks: params.scope.infraStacks,
      checkedEntries: params.scope.checkedEntries,
    },
    results: [...params.results],
  };
}

/** 監査レポートの総合判定を終了コードへ変換する（0: 適合 / 1: 不適合 / 2: 判定不能）。 */
export function auditExitCode(report: AuditReport): number {
  if (report.verdict === 'compliant') {
    return 0;
  }
  if (report.verdict === 'non-compliant') {
    return 1;
  }
  return 2;
}

/** ルール 1 件を評価し、例外・不正な戻り値を `error` の結果へ変換する。 */
async function evaluateOne(rule: ComplianceRule, context: RuleContext): Promise<RuleResult> {
  const base = {
    ruleId: rule.id,
    title: rule.title,
    category: rule.category,
    severity: rule.severity,
  };

  try {
    const raw: unknown = await rule.evaluate(context);
    if (!isRuleEvaluation(raw)) {
      throw new Error('ルールが妥当な評価結果（status と evidence）を返しませんでした');
    }
    const evaluation = raw;
    return {
      ...base,
      status: evaluation.status,
      evidence: [...evaluation.evidence],
      ...(evaluation.remediation === undefined ? {} : { remediation: evaluation.remediation }),
      ...(rule.reference === undefined ? {} : { reference: rule.reference }),
      ...(evaluation.error === undefined ? {} : { error: evaluation.error }),
    };
  } catch (error) {
    return {
      ...base,
      status: 'error',
      evidence: [
        {
          subject: rule.id,
          detail: `ルール評価中に例外が発生したため、判定できませんでした: ${errorMessage(error)}`,
        },
      ],
      ...(rule.reference === undefined ? {} : { reference: rule.reference }),
      error: errorMessage(error),
    };
  }
}

/** 実行時の値が `RuleEvaluation` として最低限使えるかを判定する。 */
function isRuleEvaluation(value: unknown): value is RuleEvaluation {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as { readonly status?: unknown; readonly evidence?: unknown };
  const status = candidate.status;
  const validStatus =
    status === 'pass' || status === 'fail' || status === 'not-applicable' || status === 'error';
  return validStatus && Array.isArray(candidate.evidence);
}

/** 例外を人が読めるメッセージへ変換する（変換自体でも例外を投げない）。 */
function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message.length > 0 ? error.message : error.name;
  }
  try {
    return String(error);
  } catch {
    return '不明なエラー（メッセージを取得できませんでした）';
  }
}

/** 総合判定を導出する。 */
function decideVerdict(results: readonly RuleResult[]): AuditVerdict {
  let hasMandatoryFail = false;
  let hasMandatoryError = false;
  for (const result of results) {
    if (result.severity !== 'mandatory') {
      continue;
    }
    if (result.status === 'fail') {
      hasMandatoryFail = true;
    } else if (result.status === 'error') {
      hasMandatoryError = true;
    }
  }
  if (hasMandatoryFail) {
    return 'non-compliant';
  }
  if (hasMandatoryError) {
    return 'incomplete';
  }
  return 'compliant';
}

/** ステータス別の件数を集計する。 */
function summarize(results: readonly RuleResult[]): AuditSummary {
  let passed = 0;
  let failed = 0;
  let notApplicable = 0;
  let errored = 0;
  for (const result of results) {
    if (result.status === 'pass') {
      passed += 1;
    } else if (result.status === 'fail') {
      failed += 1;
    } else if (result.status === 'not-applicable') {
      notApplicable += 1;
    } else {
      errored += 1;
    }
  }
  return { total: results.length, passed, failed, notApplicable, errored };
}
