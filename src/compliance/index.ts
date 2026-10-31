/**
 * 適合性検証（コンプライアンス）モジュールの公開 API。
 *
 * CLI・Lambda・アプリケーション層はこのファイル経由でだけ利用する。
 * ルールの追加は `rules/` 配下で行い、`BUILTIN_RULES` に追加する。
 */
export { ARCHIVE_RULES, BUILTIN_RULES, INFRA_RULES } from './rules/index.js';
export {
  auditExitCode,
  buildAuditReport,
  evaluateRuleSet,
  evaluateRules,
} from './engine.js';
export type { BuildReportParams } from './engine.js';
export { renderAuditJson, renderAuditMarkdown } from './render.js';
