/**
 * dencho-workflow スタックのテスト。
 *
 * バッチ取り込みの Step Functions（Map + リトライ + 失敗パス）と、
 * 日次チェーン検証の EventBridge スケジュールを検証する。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TemplateDocument } from './helpers.js';
import {
  asArray,
  at,
  cfnTemplateOf,
  createTestInfra,
  documentOf,
  iamStatements,
  numberAt,
  singleResourceOfType,
  stringAt,
  templateFor,
  type TestInfra,
} from './helpers.js';

describe('dencho-workflow スタック', () => {
  let infra: TestInfra;

  beforeAll(() => {
    infra = createTestInfra();
  });

  afterAll(() => {
    infra.cleanup();
  });

  function workflowDocument(): TemplateDocument {
    return documentOf(cfnTemplateOf(infra, 'dencho-workflow'));
  }

  /**
   * Step Functions の `DefinitionString`（Fn::Join + トークン）から
   * トークンをプレースホルダ文字列に置き換えて JSON として読み出す。
   */
  function definitionOf(document: TemplateDocument): unknown {
    const stateMachine = singleResourceOfType(document, 'AWS::StepFunctions::StateMachine');
    const parts = asArray(at(stateMachine.Properties, 'DefinitionString', 'Fn::Join', '1'));
    const text = parts
      .map((part) => (typeof part === 'string' ? part : 'arn:aws:lambda:ap-northeast-1:111122223333:function:placeholder'))
      .join('');
    return JSON.parse(text) as unknown;
  }

  it('バッチ取り込みのステートマシンがある', () => {
    const template = templateFor(infra, 'dencho-workflow');
    template.resourceCountIs('AWS::StepFunctions::StateMachine', 1);

    const document = workflowDocument();
    const stateMachine = singleResourceOfType(document, 'AWS::StepFunctions::StateMachine');
    expect(stringAt(stateMachine.Properties, 'StateMachineName')).toBe('dencho-batch-import');
    // タイムアウトは ASL（DefinitionString 内）に埋め込まれる。
    expect(at(definitionOf(document), 'TimeoutSeconds')).toBe(900);
  });

  it('入力の items を Map で並列処理する（最大 5 並列）', () => {
    const definition = definitionOf(workflowDocument());
    expect(at(definition, 'StartAt')).toBe('ImportEachVoucher');
    expect(at(definition, 'States', 'ImportEachVoucher', 'Type')).toBe('Map');
    expect(at(definition, 'States', 'ImportEachVoucher', 'ItemsPath')).toBe('$.items');
    expect(at(definition, 'States', 'ImportEachVoucher', 'MaxConcurrency')).toBe(5);
    expect(at(definition, 'States', 'ImportEachVoucher', 'ItemProcessor', 'ProcessorConfig', 'Mode')).toBe('INLINE');
  });

  it('取り込みタスクは指数バックオフでリトライする', () => {
    const definition = definitionOf(workflowDocument());
    const retries = asArray(at(definition, 'States', 'ImportEachVoucher', 'ItemProcessor', 'States', 'IngestVoucher', 'Retry'));
    expect(retries.length).toBeGreaterThanOrEqual(2);

    const backoffRates = retries.map((retry) => at(retry, 'BackoffRate'));
    expect(backoffRates).toContain(2);
    expect(retries.some((retry) => at(retry, 'MaxAttempts') === 3)).toBe(true);
    expect(retries.some((retry) => JSON.stringify(at(retry, 'ErrorEquals')).includes('States.TaskFailed'))).toBe(true);
  });

  it('失敗時は Catch で失敗パスへ遷移する', () => {
    const definition = definitionOf(workflowDocument());
    const catches = asArray(at(definition, 'States', 'ImportEachVoucher', 'ItemProcessor', 'States', 'IngestVoucher', 'Catch'));
    expect(catches).toHaveLength(1);
    expect(JSON.stringify(at(catches[0], 'ErrorEquals'))).toContain('States.ALL');
    expect(at(catches[0], 'Next')).toBe('BatchImportFailed');
    expect(at(definition, 'States', 'ImportEachVoucher', 'ItemProcessor', 'States', 'BatchImportFailed', 'Type')).toBe('Fail');
    expect(at(definition, 'States', 'ImportEachVoucher', 'ItemProcessor', 'States', 'BatchImportSucceeded', 'Type')).toBe('Succeed');
  });

  it('取り込み Lambda をクロススタック参照で呼び出す（循環参照なし）', () => {
    const stateMachine = singleResourceOfType(workflowDocument(), 'AWS::StepFunctions::StateMachine');
    const definitionJson = JSON.stringify(stateMachine.Properties);
    expect(definitionJson).toContain('IngestFunction');
    expect(definitionJson).toContain('Fn::ImportValue');
    // 実行ロールは取り込み関数の ARN だけを許可する。
    const roleStatements = iamStatements(workflowDocument()).filter((statement) => statement.actions.includes('lambda:InvokeFunction'));
    expect(roleStatements).toHaveLength(1);
    expect(JSON.stringify(roleStatements[0]?.resources)).toContain('IngestFunction');
  });

  it('EventBridge が毎日 03:00 JST に検証 Lambda を起動する', () => {
    const template = templateFor(infra, 'dencho-workflow');
    template.resourceCountIs('AWS::Events::Rule', 1);

    const rule = singleResourceOfType(workflowDocument(), 'AWS::Events::Rule');
    // EventBridge の cron は UTC。18:00 UTC = 翌 03:00 JST。
    expect(stringAt(rule.Properties, 'ScheduleExpression')).toBe('cron(0 18 * * ? *)');
    expect(stringAt(rule.Properties, 'State')).toBe('ENABLED');
    expect(stringAt(rule.Properties, 'Description')).toContain('03:00 JST');

    const targets = asArray(at(rule.Properties, 'Targets'));
    expect(targets).toHaveLength(1);
    expect(JSON.stringify(at(targets[0], 'Arn'))).toContain('VerifyFunction');
    expect(numberAt(at(targets[0], 'RetryPolicy'), 'MaximumRetryAttempts')).toBe(2);
  });

  it('EventBridge から検証 Lambda を呼ぶ許可がルール側スタックに作られる', () => {
    const template = templateFor(infra, 'dencho-workflow');
    template.resourceCountIs('AWS::Lambda::Permission', 1);

    const permission = singleResourceOfType(workflowDocument(), 'AWS::Lambda::Permission');
    expect(stringAt(permission.Properties, 'Action')).toBe('lambda:InvokeFunction');
    expect(stringAt(permission.Properties, 'Principal')).toBe('events.amazonaws.com');
    expect(JSON.stringify(at(permission.Properties, 'FunctionName'))).toContain('VerifyFunction');
    expect(JSON.stringify(at(permission.Properties, 'SourceArn'))).toContain('DailyChainVerificationRule');
  });

  it('IAM ポリシーにワイルドカードが無い', () => {
    const wildcards = iamStatements(workflowDocument()).filter(
      (statement) => statement.actions.includes('*') || statement.resources.includes('*'),
    );
    expect(wildcards).toHaveLength(0);
  });
});
