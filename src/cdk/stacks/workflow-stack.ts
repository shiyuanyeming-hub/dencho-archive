/**
 * dencho-workflow スタック。
 *
 * バッチ処理と定期実行を担う。
 *
 * - Step Functions の Map ステートで入力の証憑配列を並列に取り込み、
 *   失敗時は指数バックオフでリトライし、最終的に失敗パスへ Catch する。
 * - EventBridge の日次スケジュールで検証 Lambda を起動し、ハッシュチェーンを
 *   毎日（03:00 JST）再検証する。改ざんは「次の日」には必ず検知される。
 */
import * as cdk from 'aws-cdk-lib';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import type { Construct } from 'constructs';
import type { ComputeStack } from './compute-stack.js';

/** `dencho-workflow` スタックのプロパティ。 */
export interface WorkflowStackProps extends cdk.StackProps {
  /** 実行層スタック。取り込み / 検証 Lambda を参照する（依存方向: workflow -> compute）。 */
  readonly compute: ComputeStack;
}

/**
 * バッチ取り込み（Step Functions）と日次検証（EventBridge）を構築するスタック。
 *
 * 依存方向は `dencho-workflow` -> `dencho-compute` の一方向のみ。
 * EventBridge -> Lambda の実行許可（AWS::Lambda::Permission）は CDK が
 * ルール側のスタックに作成するため、逆方向の依存は発生しない。
 */
export class WorkflowStack extends cdk.Stack {
  /** 証憑一括取り込みのステートマシン。 */
  readonly stateMachine: sfn.IStateMachine;

  /** 毎日チェーン検証を起動する EventBridge ルール。 */
  readonly dailyVerificationRule: events.Rule;

  constructor(scope: Construct, id: string, props: WorkflowStackProps) {
    super(scope, id, {
      ...props,
      description: props.description ?? 'dencho-archive: バッチ取り込み（Step Functions）+ 日次チェーン検証（EventBridge）',
    });

    const compute = props.compute;
    // 失敗パス: 一括取り込みの途中で回復不能なエラーが起きた場合に到達する。
    const failurePath = new sfn.Fail(this, 'BatchImportFailed', {
      error: 'BatchImportFailed',
      cause: '証憑の一括取り込みに失敗しました。実行履歴で失敗した項目を確認してください。',
    });

    // 1 件の取り込み。Lambda の一時的エラーは指数バックオフでリトライする。
    const ingestTask = new tasks.LambdaInvoke(this, 'IngestVoucher', {
      lambdaFunction: compute.functions.ingest,
      comment: '証憑を 1 件取り込む（冪等）',
      payloadResponseOnly: true,
      // 自動リトライは無効化し、下の Retry 定義（指数バックオフ）だけで制御する。
      retryOnServiceExceptions: false,
    });
    ingestTask.addRetry({
      errors: [
        'Lambda.ServiceException',
        'Lambda.AWSLambdaException',
        'Lambda.SdkClientException',
        'Lambda.TooManyRequestsException',
        'Lambda.ClientExecutionTimeoutException',
      ],
      interval: cdk.Duration.seconds(2),
      maxAttempts: 4,
      backoffRate: 2,
    });
    ingestTask.addRetry({
      errors: ['States.TaskFailed'],
      interval: cdk.Duration.seconds(5),
      maxAttempts: 3,
      backoffRate: 2,
    });
    ingestTask.addCatch(failurePath, {
      errors: ['States.ALL'],
      resultPath: '$.error',
    });

    // 入力の `items` 配列を Map で並列処理する。
    const batchImportMap = new sfn.Map(this, 'ImportEachVoucher', {
      comment: '入力の items 配列を最大 5 並列で取り込む',
      itemsPath: sfn.JsonPath.stringAt('$.items'),
      maxConcurrency: 5,
    });
    batchImportMap.itemProcessor(ingestTask.next(new sfn.Succeed(this, 'BatchImportSucceeded')));

    this.stateMachine = new sfn.StateMachine(this, 'BatchImportStateMachine', {
      stateMachineName: 'dencho-batch-import',
      comment: '証憑の一括取り込み（Map + 指数バックオフ + 失敗パス）',
      definitionBody: sfn.DefinitionBody.fromChainable(batchImportMap),
      timeout: cdk.Duration.minutes(15),
      // Step Functions の CloudWatch Logs への実行ログ出力は logs:CreateLogDelivery 等が
      // リソースレベル権限に対応せず Resource "*" が必要になる。最小権限方針に基づき
      // 有効化せず、実行履歴（Step Functions 側で 90 日保持）と CloudTrail で監査する。
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // 日次検証: 毎日 03:00 JST（EventBridge の cron は UTC 指定なので 18:00 UTC）。
    this.dailyVerificationRule = new events.Rule(this, 'DailyChainVerificationRule', {
      ruleName: 'dencho-daily-chain-verification',
      description: '毎日 03:00 JST にハッシュチェーンを再検証する（改ざんを翌日までに検知）',
      schedule: events.Schedule.cron({ minute: '0', hour: '18' }),
      enabled: true,
    });
    this.dailyVerificationRule.addTarget(
      new targets.LambdaFunction(compute.functions.verify, {
        retryAttempts: 2,
        maxEventAge: cdk.Duration.hours(2),
      }),
    );
  }
}
