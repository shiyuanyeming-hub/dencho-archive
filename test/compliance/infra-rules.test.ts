/**
 * インフラ系ルール（INF-01〜INF-10）のテスト。
 *
 * CDK 合成結果（InfraSnapshot）をフィクスチャで再現し、各ルールの
 * pass / fail / not-applicable と、証跡の根拠（リソース名・設定値）を固定する。
 * 実際の CDK 出力（`synthAll()`）には依存しない。
 */
import { describe, expect, it } from 'vitest';
import type { InfraSnapshot } from '../../src/core/types.js';
import {
  EMPTY_INFRA,
  evaluateRule,
  evidenceText,
  makeContext,
  makeInfra,
} from './fixtures.js';

/** INF-01〜INF-10 の ID 一覧。 */
const INFRA_RULE_IDS = [
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
] as const;

describe('インフラ定義が無い場合', () => {
  it.each(INFRA_RULE_IDS)('%s は not-applicable を返す', async (ruleId) => {
    const evaluation = await evaluateRule(ruleId, makeContext());
    expect(evaluation.status).toBe('not-applicable');
    expect(evidenceText(evaluation)).toContain('判定対象外');
  });
});

describe('INF-01 S3 Object Lock が有効', () => {
  it('Object Lock が有効なら pass し、アーカイブ用バケットを証跡に載せる', async () => {
    const evaluation = await evaluateRule('INF-01', makeContext({ infra: makeInfra() }));
    expect(evaluation.status).toBe('pass');
    const text = evidenceText(evaluation);
    expect(text).toContain('ArchiveBucket');
    expect(text).toContain('Object Lock: 有効');
  });

  it('Object Lock が無効なら fail する', async () => {
    const evaluation = await evaluateRule(
      'INF-01',
      makeContext({ infra: makeInfra({ objectLockEnabled: false, objectLockConfigured: false }) }),
    );
    expect(evaluation.status).toBe('fail');
    expect(evidenceText(evaluation)).toContain('Object Lock: 無効');
  });
});

describe('INF-02 保持モードが COMPLIANCE で 7 年以上', () => {
  it('COMPLIANCE / 2557 日なら pass する', async () => {
    const evaluation = await evaluateRule('INF-02', makeContext({ infra: makeInfra() }));
    expect(evaluation.status).toBe('pass');
    const text = evidenceText(evaluation);
    expect(text).toContain('COMPLIANCE');
    expect(text).toContain('2557 日');
  });

  it('GOVERNANCE モードなら fail する', async () => {
    const evaluation = await evaluateRule(
      'INF-02',
      makeContext({ infra: makeInfra({ retentionMode: 'GOVERNANCE' }) }),
    );
    expect(evaluation.status).toBe('fail');
    expect(evidenceText(evaluation)).toContain('GOVERNANCE');
  });

  it('保持期間が 365 日なら fail する', async () => {
    const evaluation = await evaluateRule(
      'INF-02',
      makeContext({ infra: makeInfra({ retentionDays: 365 }) }),
    );
    expect(evaluation.status).toBe('fail');
    expect(evidenceText(evaluation)).toContain('365 日');
  });

  it('デフォルト保持の設定が無ければ fail する', async () => {
    const evaluation = await evaluateRule(
      'INF-02',
      makeContext({ infra: makeInfra({ objectLockConfigured: false }) }),
    );
    expect(evaluation.status).toBe('fail');
    expect(evidenceText(evaluation)).toContain('DefaultRetention');
  });
});

describe('INF-03 バケットのバージョニングが有効', () => {
  it('バージョニングが Enabled なら pass する', async () => {
    const evaluation = await evaluateRule('INF-03', makeContext({ infra: makeInfra() }));
    expect(evaluation.status).toBe('pass');
    expect(evidenceText(evaluation)).toContain('Enabled');
  });

  it('バージョニングが Suspended なら fail する', async () => {
    const evaluation = await evaluateRule(
      'INF-03',
      makeContext({ infra: makeInfra({ versioningStatus: 'Suspended' }) }),
    );
    expect(evaluation.status).toBe('fail');
    expect(evidenceText(evaluation)).toContain('Suspended');
  });
});

describe('INF-04 パブリックアクセスが全面ブロック', () => {
  it('4 項目すべて true なら pass する', async () => {
    const evaluation = await evaluateRule('INF-04', makeContext({ infra: makeInfra() }));
    expect(evaluation.status).toBe('pass');
    expect(evidenceText(evaluation)).toContain('RestrictPublicBuckets: true');
  });

  it('ブロックが無効なら fail する', async () => {
    const evaluation = await evaluateRule(
      'INF-04',
      makeContext({ infra: makeInfra({ publicAccess: 'open' }) }),
    );
    expect(evaluation.status).toBe('fail');
    expect(evidenceText(evaluation)).toContain('false（ブロック無効）');
  });

  it('パブリックアクセスブロックの設定自体が無ければ fail する', async () => {
    const evaluation = await evaluateRule(
      'INF-04',
      makeContext({ infra: makeInfra({ publicAccess: 'absent' }) }),
    );
    expect(evaluation.status).toBe('fail');
    expect(evidenceText(evaluation)).toContain('未設定');
  });
});

describe('INF-05 保存データが暗号化されている（KMS 推奨）', () => {
  it('SSE-KMS なら pass する', async () => {
    const evaluation = await evaluateRule('INF-05', makeContext({ infra: makeInfra() }));
    expect(evaluation.status).toBe('pass');
    const text = evidenceText(evaluation);
    expect(text).toContain('aws:kms');
    expect(evaluation.remediation).toBeUndefined();
  });

  it('SSE-S3（AES256）でも暗号化されていれば pass し、KMS を推奨する', async () => {
    const evaluation = await evaluateRule(
      'INF-05',
      makeContext({ infra: makeInfra({ encryption: 'AES256' }) }),
    );
    expect(evaluation.status).toBe('pass');
    expect(evaluation.remediation).toContain('KMS');
  });

  it('暗号化が無ければ fail する', async () => {
    const evaluation = await evaluateRule(
      'INF-05',
      makeContext({ infra: makeInfra({ encryption: 'none' }) }),
    );
    expect(evaluation.status).toBe('fail');
    expect(evidenceText(evaluation)).toContain('ServerSideEncryptionConfiguration');
  });
});

describe('INF-06 TLS が強制されている', () => {
  it('aws:SecureTransport=false を Deny していれば pass する', async () => {
    const evaluation = await evaluateRule('INF-06', makeContext({ infra: makeInfra() }));
    expect(evaluation.status).toBe('pass');
    expect(evidenceText(evaluation)).toContain('TLS 強制');
  });

  it('TLS 強制の条件が無ければ fail する', async () => {
    const evaluation = await evaluateRule(
      'INF-06',
      makeContext({ infra: makeInfra({ tlsPolicy: 'no-condition' }) }),
    );
    expect(evaluation.status).toBe('fail');
    expect(evidenceText(evaluation)).toContain('ステートメントが見つかりません');
  });

  it('バケットポリシー自体が無ければ fail する', async () => {
    const evaluation = await evaluateRule(
      'INF-06',
      makeContext({ infra: makeInfra({ tlsPolicy: 'absent' }) }),
    );
    expect(evaluation.status).toBe('fail');
    expect(evidenceText(evaluation)).toContain('リソースが見つかりません');
  });
});

describe('INF-07 CloudTrail がデータイベントを記録', () => {
  it('EventSelectors で S3 オブジェクトのデータイベントを記録していれば pass する', async () => {
    const evaluation = await evaluateRule('INF-07', makeContext({ infra: makeInfra() }));
    expect(evaluation.status).toBe('pass');
    expect(evidenceText(evaluation)).toContain('記録あり');
  });

  it('AdvancedEventSelectors（resources.type = AWS::S3::Object）でも pass する', async () => {
    const evaluation = await evaluateRule(
      'INF-07',
      makeContext({ infra: makeInfra({ trailSelectorStyle: 'advanced' }) }),
    );
    expect(evaluation.status).toBe('pass');
  });

  it('データイベントを記録していなければ fail する', async () => {
    const evaluation = await evaluateRule(
      'INF-07',
      makeContext({ infra: makeInfra({ trailDataEvents: false }) }),
    );
    expect(evaluation.status).toBe('fail');
    expect(evidenceText(evaluation)).toContain('記録なし');
  });

  it('トレイル自体が無ければ fail する', async () => {
    const evaluation = await evaluateRule(
      'INF-07',
      makeContext({ infra: makeInfra({ includeTrail: false }) }),
    );
    expect(evaluation.status).toBe('fail');
    expect(evidenceText(evaluation)).toContain('リソースが見つかりません');
  });
});

describe('INF-08 DynamoDB のポイントインタイムリカバリが有効', () => {
  it('全テーブルで PITR が有効なら pass する', async () => {
    const evaluation = await evaluateRule('INF-08', makeContext({ infra: makeInfra() }));
    expect(evaluation.status).toBe('pass');
    const text = evidenceText(evaluation);
    expect(text).toContain('VoucherIndexTable');
    expect(text).toContain('AuditLogTable');
    expect(text).toContain('ChainCheckpointTable');
  });

  it('PITR が無効なら fail する', async () => {
    const evaluation = await evaluateRule(
      'INF-08',
      makeContext({ infra: makeInfra({ pitr: false }) }),
    );
    expect(evaluation.status).toBe('fail');
    expect(evidenceText(evaluation)).toContain('ポイントインタイムリカバリ: 無効');
  });

  it('テーブルが無ければ fail する', async () => {
    const evaluation = await evaluateRule(
      'INF-08',
      makeContext({ infra: makeInfra({ tables: 0 }) }),
    );
    expect(evaluation.status).toBe('fail');
    expect(evidenceText(evaluation)).toContain('リソースが見つかりません');
  });
});

describe('INF-09 KMS キーローテーションが有効', () => {
  it('キーローテーションが有効なら pass する', async () => {
    const evaluation = await evaluateRule('INF-09', makeContext({ infra: makeInfra() }));
    expect(evaluation.status).toBe('pass');
    expect(evidenceText(evaluation)).toContain('キーローテーション: 有効');
  });

  it('キーローテーションが無効なら fail する', async () => {
    const evaluation = await evaluateRule(
      'INF-09',
      makeContext({ infra: makeInfra({ kmsRotation: false }) }),
    );
    expect(evaluation.status).toBe('fail');
    expect(evidenceText(evaluation)).toContain('キーローテーション: 無効');
  });

  it('KMS キーが無ければ fail する', async () => {
    const evaluation = await evaluateRule(
      'INF-09',
      makeContext({ infra: makeInfra({ includeKmsKey: false }) }),
    );
    expect(evaluation.status).toBe('fail');
    expect(evidenceText(evaluation)).toContain('リソースが見つかりません');
  });
});

describe('INF-10 整合性検証の失敗を検知するアラームがある', () => {
  it('ChainVerificationFailure のアラームがあれば pass する', async () => {
    const evaluation = await evaluateRule('INF-10', makeContext({ infra: makeInfra() }));
    expect(evaluation.status).toBe('pass');
    const text = evidenceText(evaluation);
    expect(text).toContain('ChainVerificationFailure');
    expect(text).toContain('整合性検証の失敗を検知');
  });

  it('無関係なアラームしか無ければ fail する', async () => {
    const evaluation = await evaluateRule(
      'INF-10',
      makeContext({ infra: makeInfra({ chainAlarm: false }) }),
    );
    expect(evaluation.status).toBe('fail');
    expect(evidenceText(evaluation)).toContain('Errors');
  });

  it('アラームが 1 つも無ければ fail する', async () => {
    const noAlarms: InfraSnapshot = {
      stacks: { 'dencho-compute': { Resources: {} } },
    };
    const evaluation = await evaluateRule('INF-10', makeContext({ infra: noAlarms }));
    expect(evaluation.status).toBe('fail');
    expect(evidenceText(evaluation)).toContain('リソースが見つかりません');
  });
});

describe('アーカイブ用バケットの選択と寛容な読み取り', () => {
  it('CloudTrail ログ用バケットが併存してもアーカイブ用バケットを選ぶ', async () => {
    const infra = makeInfra();
    const evaluation = await evaluateRule('INF-01', makeContext({ infra }));
    const text = evidenceText(evaluation);
    expect(text).toContain('dencho-storage/ArchiveBucket');
    expect(text).not.toContain('CloudTrailLogsBucket');
  });

  it('バケットが 1 つも無ければ全バケット系ルールが「リソースが見つかりません」で fail する', async () => {
    for (const ruleId of ['INF-01', 'INF-02', 'INF-03', 'INF-04', 'INF-05', 'INF-06'] as const) {
      const evaluation = await evaluateRule(ruleId, makeContext({ infra: EMPTY_INFRA }));
      expect(evaluation.status, ruleId).toBe('fail');
      expect(evidenceText(evaluation), ruleId).toContain('リソースが見つかりません');
    }
  });

  it('プロパティの型が壊れていても例外を投げず fail（error ではない）にする', async () => {
    const malformed: InfraSnapshot = {
      stacks: {
        'dencho-storage': {
          Resources: {
            ArchiveBucket: {
              Type: 'AWS::S3::Bucket',
              Properties: {
                ObjectLockEnabled: 'maybe',
                ObjectLockConfiguration: 'broken',
                VersioningConfiguration: { Status: 42 },
                PublicAccessBlockConfiguration: { BlockPublicAcls: 'yes' },
                BucketEncryption: { ServerSideEncryptionConfiguration: 'broken' },
              },
            },
            ArchiveBucketPolicy: {
              Type: 'AWS::S3::BucketPolicy',
              Properties: { PolicyDocument: 42 },
            },
            BrokenTable: {
              Type: 'AWS::DynamoDB::Table',
              Properties: { PointInTimeRecoverySpecification: [] },
            },
            BrokenKey: {
              Type: 'AWS::KMS::Key',
              Properties: { EnableKeyRotation: {} },
            },
            BrokenTrail: {
              Type: 'AWS::CloudTrail::Trail',
              Properties: { EventSelectors: 'broken', AdvancedEventSelectors: [{}] },
            },
            BrokenAlarm: {
              Type: 'AWS::CloudWatch::Alarm',
              Properties: { MetricName: 42 },
            },
          },
        },
      },
    };
    const context = makeContext({ infra: malformed });
    for (const ruleId of INFRA_RULE_IDS) {
      const evaluation = await evaluateRule(ruleId, context);
      expect(evaluation.status, ruleId).toBe('fail');
    }
  });
});
