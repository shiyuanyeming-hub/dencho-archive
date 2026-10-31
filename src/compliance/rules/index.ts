/**
 * ビルトイン適合性ルールの一覧。
 *
 * 並び順はレポートの表示順として固定する（アーカイブ系 → インフラ系）。
 * `evaluateRules` はこの順序を保ったまま評価する。
 */
import type { ComplianceRule } from '../../core/types.js';
import { ARCHIVE_RULES } from './archive.js';
import { INFRA_RULES } from './infra.js';

export { ARCHIVE_RULES, INFRA_RULES };

/**
 * dencho-archive に組み込まれた電帳法適合性ルール。
 *
 * アーカイブ（保存データ）に対する 10 ルールと、CDK で合成したインフラに
 * 対する 10 ルールの計 20 ルールで構成される。インフラ定義が渡されない場合、
 * インフラ系ルールは `not-applicable` を返す。
 */
export const BUILTIN_RULES: readonly ComplianceRule[] = [...ARCHIVE_RULES, ...INFRA_RULES];
