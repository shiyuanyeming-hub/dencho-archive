/**
 * 監査レポート描画（Markdown / JSON）のテスト。
 *
 * レポート出力は CLI・監査法人向けの成果物であるため、
 * 「同じ入力なら常に同じ出力（決定的）」であることと、
 * 「表・コードスパンを壊さないこと（エスケープ）」を仕様として固定する。
 */
import { describe, expect, it } from 'vitest';
import type { RuleResult } from '../../src/core/types.js';
import { renderAuditJson, renderAuditMarkdown } from '../../src/compliance/index.js';
import { makeReport, makeRuleResult } from './fixtures.js';

/** 複数カテゴリ・複数ステータスを含むサンプルレポート。 */
function sampleReport() {
  const results: readonly RuleResult[] = [
    makeRuleResult({
      ruleId: 'AUTH-01',
      title: '全証憑にタイムスタンプが付与されている',
      category: 'authenticity',
      severity: 'mandatory',
      status: 'pass',
      evidence: [
        { subject: 'タイムスタンプ付与状況', detail: '付与済み 2 件 / 未付与 0 件', value: '2/2' },
      ],
      reference: 'https://www.nta.go.jp/law/joho-zeikaishaku/sonota/031227/index.htm',
    }),
    makeRuleResult({
      ruleId: 'VIS-01',
      title: '検索対象3項目が索引化されている',
      category: 'visibility',
      severity: 'mandatory',
      status: 'fail',
      evidence: [{ subject: '不足している項目', detail: '取引先|金額の一部', value: 1 }],
      remediation: '3 項目を索引化してください。',
    }),
    makeRuleResult({
      ruleId: 'RET-01',
      title: '保存期間が7年以上',
      category: 'retention',
      severity: 'mandatory',
      status: 'not-applicable',
      evidence: [{ subject: 'アーカイブ設定', detail: '対象外のため判定していません' }],
    }),
    makeRuleResult({
      ruleId: 'INF-06',
      title: 'TLS が強制されている',
      category: 'auditability',
      severity: 'recommended',
      status: 'error',
      error: '評価中に例外が発生しました',
      evidence: [{ subject: 'INF-06', detail: 'ルール評価中に例外が発生' }],
    }),
  ];
  return makeReport({ verdict: 'non-compliant', results });
}

describe('renderAuditJson', () => {
  it('同じレポートからは常に同じ JSON になる（決定的）', () => {
    const report = sampleReport();
    expect(renderAuditJson(report)).toBe(renderAuditJson(report));
  });

  it('整形された JSON として解釈でき、主要フィールドを保持する', () => {
    const report = sampleReport();
    const parsed = JSON.parse(renderAuditJson(report)) as Record<string, unknown>;
    expect(parsed['schemaVersion']).toBe(1);
    expect(parsed['archiveId']).toBe(report.archiveId);
    expect(parsed['generatedAt']).toBe(report.generatedAt);
    expect(parsed['verdict']).toBe('non-compliant');
    const parsedResults = parsed['results'] as readonly Record<string, unknown>[];
    expect(parsedResults).toHaveLength(4);
    expect(parsedResults[0]?.['ruleId']).toBe('AUTH-01');
    expect(parsedResults[1]?.['remediation']).toBe('3 項目を索引化してください。');
    expect(parsedResults[3]?.['error']).toBe('評価中に例外が発生しました');
  });

  it('末尾に改行が 1 つ付き、ANSI エスケープを含まない', () => {
    const json = renderAuditJson(sampleReport());
    expect(json.endsWith('\n')).toBe(true);
    expect(json.includes('\u001b')).toBe(false);
  });

  it('結果の順序を保存する', () => {
    const report = sampleReport();
    const parsed = JSON.parse(renderAuditJson(report)) as {
      readonly results: readonly { readonly ruleId: string }[];
    };
    expect(parsed.results.map((result) => result.ruleId)).toStrictEqual([
      'AUTH-01',
      'VIS-01',
      'RET-01',
      'INF-06',
    ]);
  });

  it('未定義の任意フィールドはキーごと省略する', () => {
    const report = makeReport({ results: [makeRuleResult()] });
    const parsed = JSON.parse(renderAuditJson(report)) as {
      readonly results: readonly Record<string, unknown>[];
    };
    const first = parsed.results[0];
    expect(first).toBeDefined();
    expect('remediation' in (first ?? {})).toBe(false);
    expect('error' in (first ?? {})).toBe(false);
    expect('reference' in (first ?? {})).toBe(false);
  });
});

describe('renderAuditMarkdown', () => {
  it('同じレポートからは常に同じ Markdown になる（決定的）', () => {
    const report = sampleReport();
    expect(renderAuditMarkdown(report)).toBe(renderAuditMarkdown(report));
  });

  it('見出し・アーカイブ ID・生成時刻・総合判定を含む', () => {
    const markdown = renderAuditMarkdown(sampleReport());
    expect(markdown).toContain('# 電子帳簿保存法 適合性監査レポート');
    expect(markdown).toContain('## 概要');
    expect(markdown).toContain('## 集計');
    expect(markdown).toContain('## 監査対象');
    expect(markdown).toContain('## ルール別結果');
    expect(markdown).toContain('## 詳細');
    expect(markdown).toContain('arch-test');
    expect(markdown).toContain('2026-10-31T18:00:00+09:00');
    expect(markdown).toContain('**不適合**');
    expect(markdown).toContain('法的助言ではありません');
    expect(markdown.endsWith('\n')).toBe(true);
  });

  it('ルール別結果を表形式で出力する', () => {
    const markdown = renderAuditMarkdown(sampleReport());
    expect(markdown).toContain('| ルールID | 重要度 | カテゴリ | 判定 | タイトル |');
    expect(markdown).toContain('| AUTH-01 | 必須 | 真実性の確保 | 適合 |');
    expect(markdown).toContain('| VIS-01 | 必須 | 可視性の確保 | 不適合 |');
    expect(markdown).toContain('| RET-01 | 必須 | 保存期間 | 対象外 |');
    expect(markdown).toContain('| INF-06 | 推奨 | 監査証跡 | 評価エラー |');
  });

  it('証跡・改善案・エラー・参照リンクを詳細セクションに出力する', () => {
    const markdown = renderAuditMarkdown(sampleReport());
    expect(markdown).toContain('### AUTH-01 全証憑にタイムスタンプが付与されている');
    expect(markdown).toContain('付与済み 2 件 / 未付与 0 件');
    expect(markdown).toContain('（値: 2/2）');
    expect(markdown).toContain('- 改善案: 3 項目を索引化してください。');
    expect(markdown).toContain('- エラー: 評価中に例外が発生しました');
    expect(markdown).toContain(
      '[参照ドキュメント](https://www.nta.go.jp/law/joho-zeikaishaku/sonota/031227/index.htm)',
    );
  });

  it('証跡のパイプ文字をエスケープして表を壊さない', () => {
    const markdown = renderAuditMarkdown(sampleReport());
    expect(markdown).toContain('取引先\\|金額の一部');
  });

  it('タイトル中のパイプ文字もエスケープする', () => {
    const report = makeReport({
      results: [makeRuleResult({ title: 'タイトル|壊す|ルール' })],
    });
    const markdown = renderAuditMarkdown(report);
    expect(markdown).toContain('タイトル\\|壊す\\|ルール');
  });

  it('証跡の改行を <br> に置換して表・行構造を保つ', () => {
    const report = makeReport({
      results: [
        makeRuleResult({
          evidence: [{ subject: '複数行', detail: '1 行目\n2 行目' }],
        }),
      ],
    });
    const markdown = renderAuditMarkdown(report);
    expect(markdown).toContain('1 行目<br>2 行目');
    // 証跡の詳細行は 1 行に収まる（改行で分割されていない）。
    expect(markdown).not.toContain('1 行目\n2 行目');
  });

  it('バッククォートをエスケープしてコードスパンを閉じさせない', () => {
    const report = makeReport({
      results: [
        makeRuleResult({
          evidence: [{ subject: '`subject`', detail: '`detail`' }],
        }),
      ],
    });
    const markdown = renderAuditMarkdown(report);
    expect(markdown).toContain('\\`subject\\`');
    expect(markdown).toContain('\\`detail\\`');
  });

  it('集計件数と監査対象を表に出力する', () => {
    const markdown = renderAuditMarkdown(sampleReport());
    expect(markdown).toContain('| ルール総数 | 4 |');
    expect(markdown).toContain('| 適合 (pass) | 1 |');
    expect(markdown).toContain('| 不適合 (fail) | 1 |');
    expect(markdown).toContain('| 対象外 (not-applicable) | 1 |');
    expect(markdown).toContain('| 評価エラー (error) | 1 |');
    expect(markdown).toContain('| 証憑 | 2 件 |');
    expect(markdown).toContain('| インフラスタック | 3 |');
    expect(markdown).toContain('| 検証済み台帳エントリ | 2 |');
  });

  it('結果が 0 件でも壊れずに描画できる', () => {
    const report = makeReport({ results: [] });
    const markdown = renderAuditMarkdown(report);
    expect(markdown).toContain('（評価されたルールはありません）');
    expect(markdown).toContain('**適合**');
    expect(markdown.endsWith('\n')).toBe(true);
  });

  it('判定不能（incomplete）のラベルを出力する', () => {
    const report = makeReport({
      verdict: 'incomplete',
      results: [
        makeRuleResult({ ruleId: 'AUTH-01', status: 'error', error: '失敗しました' }),
      ],
    });
    const markdown = renderAuditMarkdown(report);
    expect(markdown).toContain('**判定不能**');
    expect(markdown).toContain('評価エラー');
  });

  it('証跡が無いルールは「（なし）」と表示する', () => {
    const report = makeReport({ results: [makeRuleResult({ evidence: [] })] });
    const markdown = renderAuditMarkdown(report);
    expect(markdown).toContain('- 証跡: （なし）');
  });
});
