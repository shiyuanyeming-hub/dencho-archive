/**
 * dencho-guardrails スタックのテスト。
 *
 * 監査証跡（CloudTrail のデータイベント・Object Lock ログ保管）と、
 * チェーン検証失敗の監視設定を検証する。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TemplateDocument } from './helpers.js';
import {
  asArray,
  at,
  booleanAt,
  cfnTemplateOf,
  createTestInfra,
  documentOf,
  iamStatements,
  numberAt,
  resourcesOfType,
  singleResourceOfType,
  stringAt,
  templateFor,
  type TestInfra,
} from './helpers.js';

describe('dencho-guardrails スタック', () => {
  let infra: TestInfra;

  beforeAll(() => {
    infra = createTestInfra();
  });

  afterAll(() => {
    infra.cleanup();
  });

  function guardrailsDocument(): TemplateDocument {
    return documentOf(cfnTemplateOf(infra, 'dencho-guardrails'));
  }

  it('マルチリージョン・グローバルイベント・ログファイル検証付きの CloudTrail がある', () => {
    const template = templateFor(infra, 'dencho-guardrails');
    template.resourceCountIs('AWS::CloudTrail::Trail', 1);
    template.hasResourceProperties('AWS::CloudTrail::Trail', {
      IsMultiRegionTrail: true,
      IncludeGlobalServiceEvents: true,
      EnableLogFileValidation: true,
      IsLogging: true,
    });
  });

  it('管理イベントと証憑バケットの S3 データイベント（読み書き）を記録する', () => {
    const trail = singleResourceOfType(guardrailsDocument(), 'AWS::CloudTrail::Trail');
    const selectors = asArray(at(trail.Properties, 'EventSelectors'));
    expect(selectors).toHaveLength(2);

    const [management, dataEvents] = selectors;
    expect(booleanAt(management, 'IncludeManagementEvents')).toBe(true);
    expect(stringAt(management, 'ReadWriteType')).toBe('All');

    expect(stringAt(dataEvents, 'ReadWriteType')).toBe('All');
    const dataResources = asArray(at(dataEvents, 'DataResources'));
    expect(dataResources).toHaveLength(1);
    expect(stringAt(dataResources[0], 'Type')).toBe('AWS::S3::Object');
    // データイベントの対象は証憑アーカイブバケット（クロススタック参照）。
    expect(JSON.stringify(at(dataResources[0], 'Values'))).toContain('ArchiveBucket');
  });

  it('CloudTrail のログは Object Lock 付きの専用バケットに 7 年保管する', () => {
    const document = guardrailsDocument();
    // guardrails が持つバケットは CloudTrail ログ専用の 1 つだけ。
    expect(resourcesOfType(document, 'AWS::S3::Bucket')).toHaveLength(1);

    const template = templateFor(infra, 'dencho-guardrails');
    template.hasResourceProperties('AWS::S3::Bucket', {
      VersioningConfiguration: { Status: 'Enabled' },
      ObjectLockEnabled: true,
      ObjectLockConfiguration: {
        ObjectLockEnabled: 'Enabled',
        Rule: { DefaultRetention: { Mode: 'COMPLIANCE', Days: 2557 } },
      },
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });

    const bucket = singleResourceOfType(document, 'AWS::S3::Bucket');
    expect(bucket.DeletionPolicy).toBe('Retain');
    expect(numberAt(bucket.Properties, 'ObjectLockConfiguration', 'Rule', 'DefaultRetention', 'Days')).toBe(2557);
  });

  it('CloudTrail 用バケットポリシーがログ書き込みと TLS 強制を許可する', () => {
    const document = guardrailsDocument();
    const policy = singleResourceOfType(document, 'AWS::S3::BucketPolicy');
    const statements = asArray(at(policy.Properties, 'PolicyDocument', 'Statement'));
    expect(statements.length).toBeGreaterThanOrEqual(3);

    // CloudTrail サービスに GetBucketAcl を許可している。
    const aclStatement = statements.find(
      (statement) =>
        stringAt(statement, 'Principal', 'Service') === 'cloudtrail.amazonaws.com' &&
        JSON.stringify(at(statement, 'Action')).includes('s3:GetBucketAcl'),
    );
    expect(aclStatement).toBeDefined();

    // PutObject を許可している（CloudTrail のログ納品）。
    const putStatement = statements.find(
      (statement) =>
        stringAt(statement, 'Principal', 'Service') === 'cloudtrail.amazonaws.com' &&
        JSON.stringify(at(statement, 'Action')).includes('s3:PutObject'),
    );
    expect(putStatement).toBeDefined();

    // HTTPS 以外は拒否する。
    const tlsDeny = statements.some(
      (statement) => stringAt(statement, 'Effect') === 'Deny' && at(statement, 'Condition', 'Bool', 'aws:SecureTransport') === 'false',
    );
    expect(tlsDeny).toBe(true);
  });

  it('チェーン検証失敗のカスタムメトリクスアラームがある', () => {
    const template = templateFor(infra, 'dencho-guardrails');
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      Namespace: 'DenchoArchive',
      MetricName: 'ChainVerificationFailure',
      Statistic: 'Sum',
      Threshold: 1,
      EvaluationPeriods: 1,
    });

    const alarm = singleResourceOfType(guardrailsDocument(), 'AWS::CloudWatch::Alarm');
    expect(stringAt(alarm.Properties, 'AlarmName')).toBe('dencho-chain-verification-failure');
    expect(stringAt(alarm.Properties, 'ComparisonOperator')).toBe('GreaterThanOrEqualToThreshold');
    expect(stringAt(alarm.Properties, 'TreatMissingData')).toBe('notBreaching');
  });

  it('運用ダッシュボードに Lambda・チェーン検証・DLQ の指標を載せている', () => {
    const template = templateFor(infra, 'dencho-guardrails');
    template.resourceCountIs('AWS::CloudWatch::Dashboard', 1);

    const dashboard = singleResourceOfType(guardrailsDocument(), 'AWS::CloudWatch::Dashboard');
    expect(stringAt(dashboard.Properties, 'DashboardName')).toBe('dencho-archive-operations');
    const body = JSON.stringify(dashboard.Properties);
    expect(body).toContain('AWS/Lambda');
    expect(body).toContain('Errors');
    expect(body).toContain('DenchoArchive');
    expect(body).toContain('ChainVerificationFailure');
    expect(body).toContain('ApproximateNumberOfMessagesVisible');
    expect(body).toContain('VerifyFunction');
  });

  it('監査層は IAM ロールを持たず（不要な権限がない）、ワイルドカードも無い', () => {
    const document = guardrailsDocument();
    expect(resourcesOfType(document, 'AWS::IAM::Role')).toHaveLength(0);
    const wildcards = iamStatements(document).filter(
      (statement) => statement.actions.includes('*') || statement.resources.includes('*'),
    );
    expect(wildcards).toHaveLength(0);
  });
});
