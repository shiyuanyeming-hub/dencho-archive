/**
 * dencho-compute スタックのテスト。
 *
 * 4 つの Lambda、最小権限の IAM、DLQ、アラーム、ログ保持が
 * 合成テンプレート上で期待どおりになっているかを検証する。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TemplateDocument } from './helpers.js';
import {
  actionsForRole,
  asArray,
  at,
  cfnTemplateOf,
  createTestInfra,
  documentOf,
  iamStatements,
  numberAt,
  resourcesOfType,
  roleLogicalIdOfFunction,
  statementsForRole,
  stringAt,
  templateFor,
  type TestInfra,
} from './helpers.js';

/** 期待する Lambda の構成。 */
const EXPECTED_FUNCTIONS: readonly {
  readonly name: string;
  readonly handler: string;
  readonly timeoutSeconds: number;
  readonly memorySize: number;
}[] = [
  { name: 'dencho-ingest', handler: 'ingest.handler', timeoutSeconds: 60, memorySize: 1024 },
  { name: 'dencho-search', handler: 'search.handler', timeoutSeconds: 15, memorySize: 512 },
  { name: 'dencho-export', handler: 'export.handler', timeoutSeconds: 60, memorySize: 1024 },
  { name: 'dencho-verify', handler: 'verify.handler', timeoutSeconds: 300, memorySize: 1024 },
];

describe('dencho-compute スタック', () => {
  let infra: TestInfra;

  beforeAll(() => {
    infra = createTestInfra();
  });

  afterAll(() => {
    infra.cleanup();
  });

  function computeDocument(): TemplateDocument {
    return documentOf(cfnTemplateOf(infra, 'dencho-compute'));
  }

  it('Lambda 4 関数を Node.js 22（arm64）で合成する', () => {
    const template = templateFor(infra, 'dencho-compute');
    template.resourceCountIs('AWS::Lambda::Function', 4);

    const functions = resourcesOfType(computeDocument(), 'AWS::Lambda::Function');
    const names = functions.map(({ resource }) => stringAt(resource.Properties, 'FunctionName')).sort();
    expect(names).toEqual(EXPECTED_FUNCTIONS.map((spec) => spec.name).sort());
    for (const { logicalId, resource } of functions) {
      expect(stringAt(resource.Properties, 'Runtime'), `${logicalId} のランタイム`).toBe('nodejs22.x');
      expect(stringAt(resource.Properties, 'Architectures', '0'), `${logicalId} のアーキテクチャ`).toBe('arm64');
    }
  });

  it('ハンドラは ingest / search / export / verify の 4 本', () => {
    const handlers = resourcesOfType(computeDocument(), 'AWS::Lambda::Function')
      .map(({ resource }) => stringAt(resource.Properties, 'Handler'))
      .sort();
    expect(handlers).toEqual(['export.handler', 'ingest.handler', 'search.handler', 'verify.handler']);
  });

  it('各関数のタイムアウトとメモリサイズが明示されている', () => {
    const functions = resourcesOfType(computeDocument(), 'AWS::Lambda::Function');
    for (const spec of EXPECTED_FUNCTIONS) {
      const fn = functions.find(({ resource }) => stringAt(resource.Properties, 'FunctionName') === spec.name);
      expect(fn, `${spec.name} が存在すること`).toBeDefined();
      expect(numberAt(fn?.resource.Properties, 'Timeout'), `${spec.name} のタイムアウト`).toBe(spec.timeoutSeconds);
      expect(numberAt(fn?.resource.Properties, 'MemorySize'), `${spec.name} のメモリ`).toBe(spec.memorySize);
      // コードはビルド済みハンドラのアセットから読み込む。
      expect(stringAt(fn?.resource.Properties, 'Code', 'S3Key'), `${spec.name} のコードアセット`).toBeDefined();
    }
  });

  it('非同期呼び出しの失敗は DLQ に退避し、再試行も設定されている', () => {
    const document = computeDocument();
    const functions = resourcesOfType(document, 'AWS::Lambda::Function');
    const withDlq = functions.filter(({ resource }) => at(resource.Properties, 'DeadLetterConfig') !== undefined);
    expect(withDlq).toHaveLength(1);
    expect(stringAt(withDlq[0]?.resource.Properties, 'FunctionName')).toBe('dencho-ingest');

    const queues = resourcesOfType(document, 'AWS::SQS::Queue');
    expect(queues).toHaveLength(1);
    const dlq = queues[0]?.resource.Properties;
    expect(stringAt(dlq, 'QueueName')).toBe('dencho-ingest-dlq');
    expect(numberAt(dlq, 'MessageRetentionPeriod')).toBe(14 * 24 * 60 * 60);
    expect(stringAt(dlq, 'KmsMasterKeyId')).toBe('alias/aws/sqs');

    // 非同期呼び出しの再試行設定（最大 2 回・6 時間）。
    const eventInvoke = resourcesOfType(document, 'AWS::Lambda::EventInvokeConfig');
    expect(eventInvoke).toHaveLength(1);
    expect(JSON.stringify(eventInvoke[0]?.resource.Properties)).toContain('MaximumRetryAttempts');
  });

  it('DLQ の TLS 強制ポリシーがある', () => {
    const document = computeDocument();
    const policies = resourcesOfType(document, 'AWS::SQS::QueuePolicy');
    expect(policies).toHaveLength(1);
    const statements = asArray(at(policies[0]?.resource.Properties, 'PolicyDocument', 'Statement'));
    const deniesPlainHttp = statements.some(
      (statement) =>
        stringAt(statement, 'Effect') === 'Deny' &&
        at(statement, 'Condition', 'Bool', 'aws:SecureTransport') === 'false',
    );
    expect(deniesPlainHttp).toBe(true);
  });

  it('関数ごとに専用ロググループを持ち、保持期間は 731 日', () => {
    const template = templateFor(infra, 'dencho-compute');
    template.resourceCountIs('AWS::Logs::LogGroup', 4);

    const document = computeDocument();
    const logGroups = resourcesOfType(document, 'AWS::Logs::LogGroup');
    for (const { resource } of logGroups) {
      expect(numberAt(resource.Properties, 'RetentionInDays')).toBe(731);
      expect(stringAt(resource.Properties, 'LogGroupName')).toMatch(/^\/aws\/lambda\/dencho-(ingest|search|export|verify)$/);
    }

    // 関数は自分のロググループを LoggingConfig で参照する。
    for (const { resource } of resourcesOfType(document, 'AWS::Lambda::Function')) {
      const logGroupRef = stringAt(resource.Properties, 'LoggingConfig', 'LogGroup', 'Ref');
      expect(logGroupRef, `${stringAt(resource.Properties, 'FunctionName')} のロググループ参照`).toBeDefined();
      const referenced = logGroups.find(({ logicalId }) => logicalId === logGroupRef);
      expect(referenced).toBeDefined();
      expect(stringAt(referenced?.resource.Properties, 'LogGroupName')).toBe(`/aws/lambda/${stringAt(resource.Properties, 'FunctionName')}`);
    }
  });

  it('各関数に Errors / Throttles のアラームがある（計 8 個）', () => {
    const document = computeDocument();
    const alarms = resourcesOfType(document, 'AWS::CloudWatch::Alarm');
    const lambdaAlarms = alarms.filter(({ resource }) => stringAt(resource.Properties, 'Namespace') === 'AWS/Lambda');
    expect(lambdaAlarms).toHaveLength(8);

    const functions = resourcesOfType(document, 'AWS::Lambda::Function');
    for (const { logicalId } of functions) {
      const metrics = lambdaAlarms
        .filter(({ resource }) => stringAt(resource.Properties, 'Dimensions', '0', 'Value', 'Ref') === logicalId)
        .map(({ resource }) => stringAt(resource.Properties, 'MetricName'))
        .sort();
      expect(metrics, `${logicalId} のアラーム`).toEqual(['Errors', 'Throttles']);
    }
  });

  it('DLQ 滞留を検知するアラームがある', () => {
    const alarms = resourcesOfType(computeDocument(), 'AWS::CloudWatch::Alarm');
    const dlqAlarm = alarms.find(({ resource }) => stringAt(resource.Properties, 'Namespace') === 'AWS/SQS');
    expect(dlqAlarm).toBeDefined();
    expect(stringAt(dlqAlarm?.resource.Properties, 'MetricName')).toBe('ApproximateNumberOfMessagesVisible');
    expect(numberAt(dlqAlarm?.resource.Properties, 'Threshold')).toBe(1);
  });

  it('IAM ポリシーにワイルドカードの Action / Resource が無い', () => {
    const statements = iamStatements(computeDocument());
    expect(statements.length).toBeGreaterThan(0);
    for (const statement of statements) {
      expect(statement.actions, `${statement.source} の Action`).not.toContain('*');
      expect(statement.resources, `${statement.source} の Resource`).not.toContain('*');
    }
  });

  it('AWS マネージドポリシーに依存しない（ログ権限もロググループ限定）', () => {
    const document = computeDocument();
    const roles = resourcesOfType(document, 'AWS::IAM::Role');
    expect(roles).toHaveLength(4);
    for (const { logicalId, resource } of roles) {
      expect(resource.Properties?.['ManagedPolicyArns'], `${logicalId} はマネージドポリシーを持たない`).toBeUndefined();
    }
  });

  it('取り込みだけが S3 書き込みと DynamoDB 追記を許可される（削除権限なし）', () => {
    const document = computeDocument();
    const ingestRole = roleLogicalIdOfFunction(document, 'dencho-ingest');
    expect(ingestRole).toBeDefined();
    const s3Actions = actionsForRole(document, ingestRole ?? '')
      .filter((action) => action.startsWith('s3:'))
      .sort();
    expect(s3Actions).toEqual(['s3:PutObject']);
    expect(actionsForRole(document, ingestRole ?? '')).toContain('dynamodb:PutItem');
    expect(actionsForRole(document, ingestRole ?? '')).toContain('kms:GenerateDataKey');
    // 削除やバケット管理系は一切与えない。
    expect(actionsForRole(document, ingestRole ?? '').some((action) => /^s3:(Delete|PutBucket|PutBucketPolicy|PutBucketAcl)/.test(action))).toBe(false);
    expect(actionsForRole(document, ingestRole ?? '')).not.toContain('s3:DeleteObject');
    // DLQ への送信権限（マネージドポリシーを使わないため明示付与）。
    expect(actionsForRole(document, ingestRole ?? '')).toContain('sqs:SendMessage');
  });

  it('検索・出力は読み取り専用（S3 書き込み・DynamoDB 更新なし）', () => {
    const document = computeDocument();
    for (const functionName of ['dencho-search', 'dencho-export']) {
      const roleId = roleLogicalIdOfFunction(document, functionName);
      const actions = actionsForRole(document, roleId ?? '');
      expect(actions, `${functionName} に S3 書き込み権限がない`).not.toContain('s3:PutObject');
      expect(actions.some((action) => /^s3:(Put|Delete)/.test(action))).toBe(false);
      expect(actions.some((action) => /^dynamodb:(PutItem|UpdateItem|DeleteItem|BatchWriteItem)/.test(action))).toBe(false);
      expect(actions).toContain('kms:Decrypt');
      expect(actions).not.toContain('kms:GenerateDataKey');
    }
  });

  it('検証の DynamoDB 書き込みはチェックポイント表の PutItem だけ', () => {
    const document = computeDocument();
    const verifyRole = roleLogicalIdOfFunction(document, 'dencho-verify');
    const actions = actionsForRole(document, verifyRole ?? '');
    expect(actions).toContain('dynamodb:ConditionCheckItem');
    expect(actions).toContain('dynamodb:PutItem');
    // S3 は読み取りのみ（検証は証憑を書き換えない）。
    expect(actions.some((action) => /^s3:(Put|Delete)/.test(action))).toBe(false);
    // PutItem の Resource はチェックポイント表（の ImportValue）に限定されている。
    const verifyStatements = statementsForRole(document, verifyRole ?? '').filter((statement) =>
      statement.actions.includes('dynamodb:PutItem'),
    );
    expect(verifyStatements).toHaveLength(1);
    const putResources = verifyStatements[0]?.resources ?? [];
    expect(putResources).toHaveLength(1);
    expect(JSON.stringify(putResources)).toContain('ChainCheckpointsTable');
  });

  it('環境変数で保存先を注入している', () => {
    const document = computeDocument();
    const functions = resourcesOfType(document, 'AWS::Lambda::Function');
    for (const { resource } of functions) {
      expect(at(resource.Properties, 'Environment', 'Variables', 'ARCHIVE_BUCKET')).toBeDefined();
    }
    const ingest = functions.find(({ resource }) => stringAt(resource.Properties, 'FunctionName') === 'dencho-ingest');
    expect(at(ingest?.resource.Properties, 'Environment', 'Variables', 'VOUCHER_INDEX_TABLE')).toBeDefined();
    expect(at(ingest?.resource.Properties, 'Environment', 'Variables', 'AUDIT_LOG_TABLE')).toBeDefined();
    expect(at(ingest?.resource.Properties, 'Environment', 'Variables', 'CHAIN_CHECKPOINTS_TABLE')).toBeDefined();
    // 取り込みだけが非同期失敗を DLQ に送る（他関数には DLQ を付けない）。
    const others = functions.filter(({ resource }) => stringAt(resource.Properties, 'FunctionName') !== 'dencho-ingest');
    for (const { resource } of others) {
      expect(resource.Properties?.['DeadLetterConfig']).toBeUndefined();
    }
  });
});
