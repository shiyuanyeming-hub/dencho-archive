/**
 * 監査レポートの描画（Markdown / JSON）。
 *
 * 出力はどちらも決定的であること（同じレポートからは常に同じ文字列）を保証する。
 * 時刻の再取得・ロケール依存のソート・ランダム ID の生成は行わない。
 * レポート内の文字列（ルールタイトル・証跡・エラー等）は、Markdown の表や
 * コードスパンを壊さないようにエスケープしてから埋め込む。
 */
import type {
  AuditReport,
  AuditVerdict,
  EvidenceItem,
  RequirementCategory,
  RuleResult,
  RuleSeverity,
  RuleStatus,
} from '../core/types.js';

/** 総合判定の日本語ラベル。 */
const VERDICT_LABELS: Readonly<Record<AuditVerdict, string>> = {
  compliant: '適合',
  'non-compliant': '不適合',
  incomplete: '判定不能',
};

/** ルール判定の日本語ラベル。 */
const STATUS_LABELS: Readonly<Record<RuleStatus, string>> = {
  pass: '適合',
  fail: '不適合',
  'not-applicable': '対象外',
  error: '評価エラー',
};

/** 重要度の日本語ラベル。 */
const SEVERITY_LABELS: Readonly<Record<RuleSeverity, string>> = {
  mandatory: '必須',
  recommended: '推奨',
};

/** 要件カテゴリの日本語ラベル。 */
const CATEGORY_LABELS: Readonly<Record<RequirementCategory, string>> = {
  authenticity: '真実性の確保',
  visibility: '可視性の確保',
  searchability: '検索要件',
  retention: '保存期間',
  'tax-audit-support': '税務調査対応',
  auditability: '監査証跡',
};

/**
 * 監査レポートを Markdown へ描画する。
 *
 * 見出し・集計表・ルール別結果表・ルールごとの詳細（証跡・改善案・エラー）を
 * この順で出力する。表のセパレータや見出しの記法は固定であり、
 * 入力（レポート）が同じなら出力も常に同一になる。
 */
export function renderAuditMarkdown(report: AuditReport): string {
  const lines: string[] = [];

  lines.push('# 電子帳簿保存法 適合性監査レポート', '');
  lines.push(
    '> 本レポートは dencho-archive（リファレンス実装）が生成した参考情報です。' +
      '法的助言ではありません。最終的な判断は税理士・顧問税理士等の専門家にご確認ください。',
    '',
  );

  lines.push('## 概要', '');
  lines.push(`- アーカイブ ID: ${escapeMarkdown(report.archiveId)}`);
  lines.push(`- 生成時刻: ${escapeMarkdown(report.generatedAt)}`);
  lines.push(`- スキーマバージョン: ${report.schemaVersion}`);
  lines.push(`- 総合判定: **${VERDICT_LABELS[report.verdict]}**（${report.verdict}）`);
  lines.push('');

  lines.push('## 集計', '');
  lines.push('| 項目 | 件数 |');
  lines.push('| --- | ---: |');
  lines.push(`| ルール総数 | ${report.summary.total} |`);
  lines.push(`| 適合 (pass) | ${report.summary.passed} |`);
  lines.push(`| 不適合 (fail) | ${report.summary.failed} |`);
  lines.push(`| 対象外 (not-applicable) | ${report.summary.notApplicable} |`);
  lines.push(`| 評価エラー (error) | ${report.summary.errored} |`);
  lines.push('');

  lines.push('## 監査対象', '');
  lines.push('| 項目 | 値 |');
  lines.push('| --- | ---: |');
  lines.push(`| 証憑 | ${report.scope.vouchers} 件 |`);
  lines.push(`| インフラスタック | ${report.scope.infraStacks} |`);
  lines.push(`| 検証済み台帳エントリ | ${report.scope.checkedEntries} |`);
  lines.push('');

  lines.push('## ルール別結果', '');
  if (report.results.length === 0) {
    lines.push('（評価されたルールはありません）', '');
  } else {
    lines.push('| ルールID | 重要度 | カテゴリ | 判定 | タイトル |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const result of report.results) {
      lines.push(
        `| ${escapeMarkdown(result.ruleId)} | ${SEVERITY_LABELS[result.severity]} | ${
          CATEGORY_LABELS[result.category]
        } | ${STATUS_LABELS[result.status]} | ${escapeMarkdown(result.title)} |`,
      );
    }
    lines.push('');
  }

  lines.push('## 詳細', '');
  if (report.results.length === 0) {
    lines.push('（評価されたルールはありません）', '');
  } else {
    for (const result of report.results) {
      renderResultDetail(lines, result);
    }
  }

  lines.push('---', '');
  lines.push(
    '本レポートはリファレンス実装による参考情報であり、法的助言ではありません。' +
      '最終的な判断は税理士等の専門家へご相談ください。',
    '',
  );

  return lines.join('\n');
}

/**
 * 監査レポートを JSON へ描画する。
 *
 * `AuditReport` をそのまま（整形して）シリアライズするだけであり、
 * キー順はオブジェクトの定義順で固定されるため出力は決定的である。
 */
export function renderAuditJson(report: AuditReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

/** ルール 1 件分の詳細セクションを追記する。 */
function renderResultDetail(lines: string[], result: RuleResult): void {
  lines.push(`### ${escapeMarkdown(result.ruleId)} ${escapeMarkdown(result.title)}`, '');
  lines.push(`- 重要度: ${SEVERITY_LABELS[result.severity]}`);
  lines.push(`- カテゴリ: ${CATEGORY_LABELS[result.category]}`);
  lines.push(`- 判定: ${STATUS_LABELS[result.status]}`);
  if (result.reference !== undefined) {
    lines.push(`- 参照: [参照ドキュメント](${result.reference})`);
  }
  if (result.evidence.length === 0) {
    lines.push('- 証跡: （なし）');
  } else {
    lines.push('- 証跡:');
    for (const item of result.evidence) {
      lines.push(`  - ${formatEvidence(item)}`);
    }
  }
  if (result.remediation !== undefined) {
    lines.push(`- 改善案: ${escapeMarkdown(result.remediation)}`);
  }
  if (result.error !== undefined) {
    lines.push(`- エラー: ${escapeMarkdown(result.error)}`);
  }
  lines.push('');
}

/** 証跡 1 件を 1 行の Markdown へ整形する。 */
function formatEvidence(item: EvidenceItem): string {
  const value =
    item.value === undefined || item.value === null
      ? ''
      : `（値: ${escapeMarkdown(String(item.value))}）`;
  return `${escapeMarkdown(item.subject)}: ${escapeMarkdown(item.detail)}${value}`;
}

/**
 * Markdown の表・見出し・コードスパンを壊さないように文字列をエスケープする。
 *
 * - `\` と `|` は表の列区切りを壊せないようエスケープする
 * - 改行は `<br>` に置換し、1 セル 1 行を保つ
 * - バックチックはコードスパンを閉じないようエスケープする
 */
function escapeMarkdown(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/\r\n|\r|\n/g, '<br>')
    .replace(/`/g, '\\`');
}
