/**
 * dencho-guardrails スタック。
 *
 * 「誰がいつ何をしたか」を後から証明するための監査証跡層である。
 *
 * - CloudTrail（マルチリージョン）で管理イベントに加え、証憑バケットの
 *   S3 データイベント（読み取り・書き込み）を記録する。
 * - CloudTrail のログは専用バケットへ 7 年（2557 日）の Object Lock
 *   （COMPLIANCE）付きで退避する。ログ自体も改ざんできない。
 * - 運用ダッシュボードと、チェーン検証失敗を検知するカスタムメトリクス
 *   アラームを提供する。
 */
import * as cdk from 'aws-cdk-lib';
import * as cloudtrail from 'aws-cdk-lib/aws-cloudtrail';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as s3 from 'aws-cdk-lib/aws-s3';
import type { Construct } from 'constructs';
import type { ComputeStack } from './compute-stack.js';
import { RETENTION_DAYS } from './storage-stack.js';
import type { StorageStack } from './storage-stack.js';

/** チェーン検証失敗を表すカスタムメトリクスの名前空間。 */
export const CHAIN_FAILURE_METRIC_NAMESPACE = 'DenchoArchive';

/** チェーン検証失敗を表すカスタムメトリクス名。 */
export const CHAIN_FAILURE_METRIC_NAME = 'ChainVerificationFailure';

/** `dencho-guardrails` スタックのプロパティ。 */
export interface GuardrailsStackProps extends cdk.StackProps {
  /** 保存層スタック。証憑バケットのデータイベントを記録するために参照する。 */
  readonly storage: StorageStack;
  /** 実行層スタック。ダッシュボードのメトリクス参照に使う。 */
  readonly compute: ComputeStack;
}

/**
 * 監査証跡（CloudTrail + ダッシュボード + アラーム）を構築するスタック。
 *
 * 依存方向は `dencho-guardrails` -> (`dencho-storage`, `dencho-compute`) の
 * 一方向のみで、循環参照は生じない。
 */
export class GuardrailsStack extends cdk.Stack {
  /** マルチリージョンの CloudTrail 証跡。 */
  readonly trail: cloudtrail.Trail;

  /** CloudTrail ログを Object Lock 付きで保管する専用バケット。 */
  readonly trailLogBucket: s3.IBucket;

  /** チェーン検証失敗を検知するカスタムメトリクスアラーム。 */
  readonly chainVerificationAlarm: cloudwatch.IAlarm;

  /** 運用ダッシュボード。 */
  readonly dashboard: cloudwatch.Dashboard;

  constructor(scope: Construct, id: string, props: GuardrailsStackProps) {
    super(scope, id, {
      ...props,
      description:
        props.description ?? 'dencho-archive: 監査証跡（CloudTrail + Object Lock ログ保管 + 監視ダッシュボード）',
    });

    // CloudTrail のログは「改ざんできない監査証跡」そのものなので、
    // 証憑と同じく Object Lock（COMPLIANCE / 7 年）で保存する。
    // 暗号化は SSE-S3 とする: CloudTrail サービスが書き込むため、
    // カスタマー管理キーを使う場合はキーポリシーに cloudtrail.amazonaws.com の
    // 許可が必要になる。証憑データ（機密性が高い）は別途 CMK で暗号化している。
    this.trailLogBucket = new s3.Bucket(this, 'TrailLogBucket', {
      versioned: true,
      objectLockEnabled: true,
      objectLockDefaultRetention: s3.ObjectLockRetention.compliance(cdk.Duration.days(RETENTION_DAYS)),
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    this.trail = new cloudtrail.Trail(this, 'AuditTrail', {
      trailName: 'dencho-archive-trail',
      bucket: this.trailLogBucket,
      s3KeyPrefix: 'cloudtrail',
      isMultiRegionTrail: true,
      includeGlobalServiceEvents: true,
      enableFileValidation: true,
      managementEvents: cloudtrail.ReadWriteType.ALL,
    });

    // 証憑バケットのデータイベント（オブジェクトの読み取り・書き込み）を
    // すべて記録する。誰が証憑を読んだか / 書いたかを追跡できる。
    this.trail.addS3EventSelector([{ bucket: props.storage.archiveBucket }], {
      readWriteType: cloudtrail.ReadWriteType.ALL,
    });

    const chainFailureMetric = new cloudwatch.Metric({
      namespace: CHAIN_FAILURE_METRIC_NAMESPACE,
      metricName: CHAIN_FAILURE_METRIC_NAME,
      statistic: 'Sum',
      period: cdk.Duration.minutes(5),
    });

    this.chainVerificationAlarm = new cloudwatch.Alarm(this, 'ChainVerificationFailureAlarm', {
      alarmName: 'dencho-chain-verification-failure',
      alarmDescription:
        'ハッシュチェーン検証の失敗を検知しました（電帳法の真性確保に関わる重大アラーム。台帳の改ざん・破損を疑う）',
      metric: chainFailureMetric,
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    const compute = props.compute;
    const invocationMetrics = [
      compute.functions.ingest.metricInvocations(),
      compute.functions.search.metricInvocations(),
      compute.functions.export.metricInvocations(),
      compute.functions.verify.metricInvocations(),
    ];
    const errorMetrics = [
      compute.functions.ingest.metricErrors(),
      compute.functions.search.metricErrors(),
      compute.functions.export.metricErrors(),
      compute.functions.verify.metricErrors(),
    ];
    const throttleMetrics = [
      compute.functions.ingest.metricThrottles(),
      compute.functions.search.metricThrottles(),
      compute.functions.export.metricThrottles(),
      compute.functions.verify.metricThrottles(),
    ];

    this.dashboard = new cloudwatch.Dashboard(this, 'OperationsDashboard', {
      dashboardName: 'dencho-archive-operations',
      widgets: [
        [
          new cloudwatch.GraphWidget({
            title: 'Lambda 呼び出し回数',
            left: invocationMetrics,
            width: 12,
            height: 6,
          }),
          new cloudwatch.GraphWidget({
            title: 'チェーン検証失敗（DenchoArchive / ChainVerificationFailure）',
            left: [chainFailureMetric],
            width: 12,
            height: 6,
          }),
        ],
        [
          new cloudwatch.GraphWidget({
            title: 'Lambda エラー数',
            left: errorMetrics,
            width: 12,
            height: 6,
          }),
          new cloudwatch.GraphWidget({
            title: 'Lambda スロットル数',
            left: throttleMetrics,
            width: 12,
            height: 6,
          }),
        ],
        [
          new cloudwatch.GraphWidget({
            title: '取り込み DLQ 滞留メッセージ数',
            left: [compute.deadLetterQueue.metricApproximateNumberOfMessagesVisible()],
            width: 12,
            height: 6,
          }),
          new cloudwatch.AlarmWidget({
            alarm: this.chainVerificationAlarm,
            title: 'チェーン検証失敗アラーム',
            width: 12,
            height: 6,
          }),
        ],
      ],
    });
  }
}
