/**
 * 適合性検証エンジン（評価・レポート組み立て・終了コード）のテスト。
 *
 * ルール個別の判定は archive-rules / infra-rules 側で固定する。ここでは
 * 「エンジンがルール集合を安全に評価し、総合判定を正しく導出するか」を固定する。
 */
import { describe, expect, it } from 'vitest';
import type {
  ArchiveConfig,
  ComplianceRule,
  RuleEvaluation,
  RuleResult,
} from '../../src/core/types.js';
import {
  BUILTIN_RULES,
  auditExitCode,
  buildAuditReport,
  evaluateRuleSet,
  evaluateRules,
} from '../../src/compliance/index.js';
import {
  ARCHIVE_ID,
  NOW,
  makeArchiveView,
  makeChain,
  makeContext,
  makeInfra,
  makeReport,
  makeRuleResult,
  makeVouchers,
} from './fixtures.js';

/** 例外を投げる（同期）テスト用ルール。 */
const THROWING_RULE: ComplianceRule = {
  id: 'TEST-THROW',
  title: '例外を投げるテスト用ルール',
  category: 'authenticity',
  severity: 'mandatory',
  description: 'エンジンが例外を error に変換することを確認するためのルールです。',
  evaluate(): RuleEvaluation {
    throw new Error('評価中に爆発しました');
  },
};

/** 非同期で reject するテスト用ルール。 */
const REJECTING_RULE: ComplianceRule = {
  id: 'TEST-REJECT',
  title: '非同期例外を投げるテスト用ルール',
  category: 'authenticity',
  severity: 'mandatory',
  description: '非同期の reject も error に変換されることを確認するためのルールです。',
  async evaluate(): Promise<RuleEvaluation> {
    throw new Error('非同期で失敗しました');
  },
};

/** 不正な評価結果を返すテスト用ルール。 */
const MALFORMED_RULE: ComplianceRule = {
  id: 'TEST-MALFORMED',
  title: '不正な評価結果を返すテスト用ルール',
  category: 'authenticity',
  severity: 'mandatory',
  description: 'status と evidence を持たない戻り値も error に変換されることを確認します。',
  evaluate(): RuleEvaluation {
    return {} as RuleEvaluation;
  },
};

/** 常に pass するテスト用ルールを作る。 */
function passingRule(id: string): ComplianceRule {
  return {
    id,
    title: `${id} 常に適合するルール`,
    category: 'auditability',
    severity: 'recommended',
    description: 'テスト用に常に pass を返すルールです。',
    evaluate(): RuleEvaluation {
      return { status: 'pass', evidence: [{ subject: id, detail: 'テスト証跡' }] };
    },
  };
}

/** 正常なアーカイブ + 正常なインフラの文脈。 */
function goodContext() {
  return makeContext({
    archive: makeArchiveView({ vouchers: makeVouchers(3) }),
    infra: makeInfra(),
  });
}

describe('BUILTIN_RULES の構成', () => {
  it('20 ルールを定義し、ID が一意である', () => {
    expect(BUILTIN_RULES).toHaveLength(20);
    const ids = BUILTIN_RULES.map((rule) => rule.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('必須の 19 ルール ID をすべて含む', () => {
    const expected = [
      'AUTH-01',
      'AUTH-02',
      'AUTH-03',
      'AUTH-04',
      'AUTH-05',
      'VIS-01',
      'VIS-02',
      'VIS-03',
      'RET-01',
      'DL-01',
      'INF-01',
      'INF-02',
      'INF-03',
      'INF-04',
      'INF-05',
      'INF-06',
      'INF-07',
      'INF-08',
      'INF-09',
      'INF-10',
    ];
    expect(BUILTIN_RULES.map((rule) => rule.id)).toStrictEqual(expected);
  });

  it('全ルールが日本語のタイトル・説明とメタデータを持つ', () => {
    const categories = new Set([
      'authenticity',
      'visibility',
      'searchability',
      'retention',
      'tax-audit-support',
      'auditability',
    ]);
    for (const rule of BUILTIN_RULES) {
      expect(rule.id).toMatch(/^[A-Z]+-\d{2}$/);
      expect(rule.title).toMatch(/[\u3040-\u30ff\u4e00-\u9fff]/);
      expect(rule.description.length).toBeGreaterThan(0);
      expect(categories.has(rule.category)).toBe(true);
      expect(rule.severity === 'mandatory' || rule.severity === 'recommended').toBe(true);
      expect(rule.reference ?? '').toMatch(/^https:\/\//);
    }
  });

  it('AUTH/VIS/RET/DL はアーカイブ系、INF はインフラ系として並ぶ', () => {
    const firstInfraIndex = BUILTIN_RULES.findIndex((rule) => rule.id.startsWith('INF-'));
    expect(firstInfraIndex).toBe(10);
    for (const [index, rule] of BUILTIN_RULES.entries()) {
      if (index < firstInfraIndex) {
        expect(rule.id.startsWith('INF-')).toBe(false);
      } else {
        expect(rule.id.startsWith('INF-')).toBe(true);
      }
    }
  });
});

describe('evaluateRules', () => {
  it('BUILTIN_RULES の順序を保ったまま評価する', async () => {
    const results = await evaluateRules(goodContext());
    expect(results.map((result) => result.ruleId)).toStrictEqual(
      BUILTIN_RULES.map((rule) => rule.id),
    );
  });

  it('正常なアーカイブ + インフラでは AUTH-05 だけ not-applicable、他はすべて pass する', async () => {
    const results = await evaluateRules(goodContext());
    for (const result of results) {
      if (result.ruleId === 'AUTH-05') {
        // タイムスタンプ方式を採用しているため WORM ルールは対象外。
        expect(result.status, result.ruleId).toBe('not-applicable');
      } else {
        expect(result.status, `${result.ruleId}: ${result.title}`).toBe('pass');
      }
    }
  });

  it('同じ文脈を 2 回評価しても完全に同じ結果になる（決定的）', async () => {
    const first = await evaluateRules(goodContext());
    const second = await evaluateRules(goodContext());
    expect(first).toStrictEqual(second);
  });

  it('インフラ未指定ならインフラ系 10 ルールは not-applicable、AUTH-05 も対象外になる', async () => {
    const results = await evaluateRules(makeContext({ archive: makeArchiveView() }));
    for (const result of results) {
      if (result.ruleId.startsWith('INF-') || result.ruleId === 'AUTH-05') {
        expect(result.status, result.ruleId).toBe('not-applicable');
      } else {
        expect(result.status, result.ruleId).toBe('pass');
      }
    }
  });

  it('チェーンが破損していれば必須ルールが fail する', async () => {
    const archive = makeArchiveView({
      chain: makeChain({
        status: 'broken',
        break: {
          sequence: 2,
          reason: 'entry-hash-mismatch',
          expected: 'expected-hash',
          actual: 'actual-hash',
          voucherId: 'v-002',
        },
      }),
    });
    const results = await evaluateRules(makeContext({ archive, infra: makeInfra() }));
    const auth04 = results.find((result) => result.ruleId === 'AUTH-04');
    expect(auth04?.status).toBe('fail');
  });

  it('例外を投げるルールでも監査全体を止めず、error に変換する', async () => {
    const results = await evaluateRuleSet([THROWING_RULE], makeContext());
    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe('error');
    expect(results[0]?.error).toContain('爆発');
    expect(results[0]?.evidence[0]?.detail).toContain('例外が発生');
  });

  it('非同期の reject も error に変換する', async () => {
    const results = await evaluateRuleSet([REJECTING_RULE], makeContext());
    expect(results[0]?.status).toBe('error');
    expect(results[0]?.error).toContain('非同期で失敗');
  });

  it('不正な評価結果（status / evidence 欠落）も error に変換する', async () => {
    const results = await evaluateRuleSet([MALFORMED_RULE], makeContext());
    expect(results[0]?.status).toBe('error');
    expect(results[0]?.error).toContain('妥当な評価結果');
  });

  it('ルール集合の順序をそのまま保つ', async () => {
    const results = await evaluateRuleSet(
      [passingRule('TEST-C'), passingRule('TEST-A'), passingRule('TEST-B')],
      makeContext(),
    );
    expect(results.map((result) => result.ruleId)).toStrictEqual([
      'TEST-C',
      'TEST-A',
      'TEST-B',
    ]);
  });
});

describe('buildAuditReport の総合判定', () => {
  const scope = { vouchers: 2, infraStacks: 3, checkedEntries: 2 };

  /** 指定した判定の結果リストからレポートを作る。 */
  function reportOf(results: readonly RuleResult[]) {
    return buildAuditReport({
      archiveId: ARCHIVE_ID,
      generatedAt: NOW,
      results,
      scope,
    });
  }

  it('必須ルールがすべて pass なら compliant', () => {
    const report = reportOf([
      makeRuleResult({ ruleId: 'A-01', status: 'pass' }),
      makeRuleResult({ ruleId: 'A-02', status: 'not-applicable' }),
    ]);
    expect(report.verdict).toBe('compliant');
  });

  it('必須ルールの fail が 1 件でもあれば non-compliant', () => {
    const report = reportOf([
      makeRuleResult({ ruleId: 'A-01', status: 'pass' }),
      makeRuleResult({ ruleId: 'A-02', status: 'fail' }),
    ]);
    expect(report.verdict).toBe('non-compliant');
  });

  it('推奨ルールの fail だけなら compliant', () => {
    const report = reportOf([
      makeRuleResult({ ruleId: 'A-01', status: 'pass' }),
      makeRuleResult({
        ruleId: 'A-02',
        status: 'fail',
        severity: 'recommended',
      }),
    ]);
    expect(report.verdict).toBe('compliant');
  });

  it('必須ルールの error があれば incomplete', () => {
    const report = reportOf([
      makeRuleResult({ ruleId: 'A-01', status: 'pass' }),
      makeRuleResult({ ruleId: 'A-02', status: 'error', error: '失敗' }),
    ]);
    expect(report.verdict).toBe('incomplete');
  });

  it('推奨ルールの error だけでは incomplete にしない', () => {
    const report = reportOf([
      makeRuleResult({ ruleId: 'A-01', status: 'pass' }),
      makeRuleResult({ ruleId: 'A-02', status: 'error', severity: 'recommended' }),
    ]);
    expect(report.verdict).toBe('compliant');
  });

  it('必須 fail と必須 error が併存する場合は non-compliant を優先する', () => {
    const report = reportOf([
      makeRuleResult({ ruleId: 'A-01', status: 'fail' }),
      makeRuleResult({ ruleId: 'A-02', status: 'error' }),
    ]);
    expect(report.verdict).toBe('non-compliant');
  });

  it('必須ルールの not-applicable は判定を妨げない', () => {
    const report = reportOf([
      makeRuleResult({ ruleId: 'A-01', status: 'not-applicable' }),
      makeRuleResult({ ruleId: 'A-02', status: 'not-applicable' }),
    ]);
    expect(report.verdict).toBe('compliant');
  });

  it('ステータス別の集計と対象範囲を正しくレポートへ載せる', () => {
    const results: readonly RuleResult[] = [
      makeRuleResult({ ruleId: 'A-01', status: 'pass' }),
      makeRuleResult({ ruleId: 'A-02', status: 'pass' }),
      makeRuleResult({ ruleId: 'A-03', status: 'fail' }),
      makeRuleResult({ ruleId: 'A-04', status: 'not-applicable' }),
      makeRuleResult({ ruleId: 'A-05', status: 'error' }),
    ];
    const report = buildAuditReport({
      archiveId: 'my-archive',
      generatedAt: '2026-11-01T00:00:00+09:00',
      results,
      scope: { vouchers: 10, infraStacks: 4, checkedEntries: 10 },
    });
    expect(report.schemaVersion).toBe(1);
    expect(report.archiveId).toBe('my-archive');
    expect(report.generatedAt).toBe('2026-11-01T00:00:00+09:00');
    expect(report.summary).toStrictEqual({
      total: 5,
      passed: 2,
      failed: 1,
      notApplicable: 1,
      errored: 1,
    });
    expect(report.scope).toStrictEqual({ vouchers: 10, infraStacks: 4, checkedEntries: 10 });
    expect(report.results.map((result) => result.ruleId)).toStrictEqual([
      'A-01',
      'A-02',
      'A-03',
      'A-04',
      'A-05',
    ]);
  });
});

describe('エンドツーエンド（評価 → レポート → 終了コード）', () => {
  it('正常なアーカイブ + インフラは適合（終了コード 0）になる', async () => {
    const results = await evaluateRules(goodContext());
    const report = buildAuditReport({
      archiveId: ARCHIVE_ID,
      generatedAt: NOW,
      results,
      scope: { vouchers: 3, infraStacks: 3, checkedEntries: 3 },
    });
    expect(report.verdict).toBe('compliant');
    expect(report.summary).toStrictEqual({
      total: 20,
      passed: 19,
      failed: 0,
      notApplicable: 1,
      errored: 0,
    });
    expect(auditExitCode(report)).toBe(0);
  });

  it('インフラ未指定でも必須ルールが満たされていれば適合になる', async () => {
    const results = await evaluateRules(makeContext());
    const report = buildAuditReport({
      archiveId: ARCHIVE_ID,
      generatedAt: NOW,
      results,
      scope: { vouchers: 2, infraStacks: 0, checkedEntries: 2 },
    });
    expect(report.verdict).toBe('compliant');
    expect(report.summary.notApplicable).toBe(11);
    expect(auditExitCode(report)).toBe(0);
  });

  it('証憑の欠落やチェーン破損があると不適合（終了コード 1）になる', async () => {
    const archive = makeArchiveView({
      vouchers: makeVouchers(2, () => ({ timestamp: null })),
      chain: makeChain({
        status: 'broken',
        break: {
          sequence: 1,
          reason: 'content-mismatch',
          expected: 'expected',
          actual: 'actual',
          voucherId: 'v-001',
        },
      }),
    });
    const results = await evaluateRules(makeContext({ archive, infra: makeInfra() }));
    const report = buildAuditReport({
      archiveId: ARCHIVE_ID,
      generatedAt: NOW,
      results,
      scope: { vouchers: 2, infraStacks: 3, checkedEntries: 2 },
    });
    expect(report.verdict).toBe('non-compliant');
    expect(report.summary.failed).toBeGreaterThan(0);
    expect(auditExitCode(report)).toBe(1);
  });

  it('評価不能な必須ルールがあると判定不能（終了コード 2）になる', async () => {
    const results = await evaluateRuleSet([THROWING_RULE], makeContext());
    const report = buildAuditReport({
      archiveId: ARCHIVE_ID,
      generatedAt: NOW,
      results,
      scope: { vouchers: 0, infraStacks: 0, checkedEntries: 0 },
    });
    expect(report.verdict).toBe('incomplete');
    expect(auditExitCode(report)).toBe(2);
  });

  it('監査結果は入力の結果リストを変更しない（不変）', async () => {
    const results = await evaluateRules(goodContext());
    const snapshot = JSON.stringify(results);
    buildAuditReport({
      archiveId: ARCHIVE_ID,
      generatedAt: NOW,
      results,
      scope: { vouchers: 0, infraStacks: 0, checkedEntries: 0 },
    });
    expect(JSON.stringify(results)).toBe(snapshot);
  });

  it('makeReport フィクスチャは集計を自動計算する（テストヘルパーの健全性）', () => {
    const report = makeReport({
      results: [
        makeRuleResult({ ruleId: 'A-01', status: 'pass' }),
        makeRuleResult({ ruleId: 'A-02', status: 'fail' }),
      ],
    });
    expect(report.summary.total).toBe(2);
    expect(report.summary.passed).toBe(1);
    expect(report.summary.failed).toBe(1);
  });
});

describe('真実性の確保の方式選択（リード指摘の 3 シナリオ）', () => {
  it('シナリオ1: 通常のローカルアーカイブ（タイムスタンプあり・worm=false・インフラ無し）は適合', async () => {
    const results = await evaluateRules(
      makeContext({ config: { requireTimestamp: true, worm: false } }),
    );
    const auth05 = results.find((result) => result.ruleId === 'AUTH-05');
    expect(auth05?.status).toBe('not-applicable');
    const report = buildAuditReport({
      archiveId: ARCHIVE_ID,
      generatedAt: NOW,
      results,
      scope: { vouchers: 2, infraStacks: 0, checkedEntries: 2 },
    });
    expect(report.verdict).toBe('compliant');
    expect(report.summary.failed).toBe(0);
  });

  it('シナリオ2: タイムスタンプも WORM も無ければ必須ルール fail で不適合', async () => {
    const results = await evaluateRules(
      makeContext({ config: { requireTimestamp: false, worm: false } }),
    );
    const auth01 = results.find((result) => result.ruleId === 'AUTH-01');
    const auth05 = results.find((result) => result.ruleId === 'AUTH-05');
    expect(auth01?.status).toBe('not-applicable');
    expect(auth05?.status).toBe('fail');
    expect(auth05?.severity).toBe('mandatory');
    const report = buildAuditReport({
      archiveId: ARCHIVE_ID,
      generatedAt: NOW,
      results,
      scope: { vouchers: 2, infraStacks: 0, checkedEntries: 2 },
    });
    expect(report.verdict).toBe('non-compliant');
    expect(auditExitCode(report)).toBe(1);
  });

  it('シナリオ3: タイムスタンプが無くてもインフラの Object Lock で真実性を確保すれば適合', async () => {
    const results = await evaluateRules(
      makeContext({ config: { requireTimestamp: false, worm: false }, infra: makeInfra() }),
    );
    const auth05 = results.find((result) => result.ruleId === 'AUTH-05');
    expect(auth05?.status).toBe('pass');
    const report = buildAuditReport({
      archiveId: ARCHIVE_ID,
      generatedAt: NOW,
      results,
      scope: { vouchers: 2, infraStacks: 3, checkedEntries: 2 },
    });
    expect(report.verdict).toBe('compliant');
    expect(auditExitCode(report)).toBe(0);
  });
});

describe('設定の扱い', () => {
  it('timestampMaxDelayDays を変えると AUTH-02 の判定が変わる', async () => {
    const archive = makeArchiveView({ vouchers: makeVouchers(1) });
    const strictConfig: Partial<ArchiveConfig> = { timestampMaxDelayDays: 10 };
    const evaluation = await evaluateRules(makeContext({ archive, config: strictConfig }));
    const auth02 = evaluation.find((result) => result.ruleId === 'AUTH-02');
    expect(auth02?.status).toBe('fail');
  });
});
