/**
 * dencho-compute スタック。
 *
 * 取り込み・検索・出力・検証の 4 つの Lambda を実行基盤として構築する。
 * 設計上の要点:
 *
 * - 実行ロールはすべて自前で作り、AWS マネージドポリシー
 *   （`AWSLambdaBasicExecutionRole` など）に頼らない。付与する IAM 権限は
 *   関数ごとに列挙し、`Action: "*"` / `Resource: "*"` を一切使わない。
 * - 取り込み関数だけが S3 への書き込み（`s3:PutObject`）と DynamoDB への
 *   追記を許可される。削除系の権限はどの関数にも与えない。
 * - 失敗した非同期呼び出しは SQS のデッドレターキューへ退避する。
 * - Lambda のログは CloudWatch Logs に 731 日（`RetentionDays.TWO_YEARS`）
 *   保持する。CloudWatch Logs の保持上限は 10 年（`TEN_YEARS`）であり
 *   法定の 7 年を超える保持はできないため、長期の監査証跡は CloudTrail の
 *   データイベント（Object Lock 付きバケットへ 7 年）と台帳・監査ログ
 *   （DynamoDB）で担保する。詳細は docs/INFRA.ja.md を参照。
 */
import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import type { Construct } from 'constructs';
import type { StorageStack } from './storage-stack.js';

/** Lambda の役割（ハンドラ）. */
export type HandlerKind = 'ingest' | 'search' | 'export' | 'verify';

/**
 * 4 つの Lambda 関数。
 *
 * 後続スタック（guardrails / workflow）はこのインタフェースだけを受け取る。
 */
export type ComputeFunctions = Readonly<Record<HandlerKind, lambda.IFunction>>;

/** `dencho-compute` スタックのプロパティ。 */
export interface ComputeStackProps extends cdk.StackProps {
  /** 保存層スタック。バケット / テーブル / キーの参照に使う（依存方向: compute -> storage）。 */
  readonly storage: StorageStack;
  /** Lambda ハンドラ（ビルド済み JavaScript）のディレクトリ。 */
  readonly handlersDir: string;
}

/** Lambda 関数の定義内容（1 関数分）。 */
interface HandlerFunctionSpec {
  /** 役割。 */
  readonly kind: HandlerKind;
  /** Lambda ハンドラ文字列（`<file>.<export>`）。 */
  readonly handler: string;
  /** タイムアウト秒。 */
  readonly timeoutSeconds: number;
  /** メモリサイズ（MB）。 */
  readonly memorySize: number;
  /** 関数の説明（日本語）。 */
  readonly description: string;
  /** 環境変数。 */
  readonly environment: Record<string, string>;
  /** 非同期呼び出し失敗時のデッドレターキュー。 */
  readonly deadLetterQueue?: sqs.IQueue;
}

/** 生成した 1 関数分のリソース束。 */
interface HandlerResources {
  /** Lambda 関数本体。 */
  readonly fn: lambda.Function;
  /** 関数専用のロググループ。 */
  readonly logGroup: logs.LogGroup;
  /** 関数専用の実行ロール。 */
  readonly role: iam.Role;
}

/** 役割ごとの日本語ラベル（アラーム説明・ロール説明に使う）。 */
const HANDLER_LABELS: Readonly<Record<HandlerKind, string>> = {
  ingest: '証憑の取り込み',
  search: '検索',
  export: 'ダウンロード出力',
  verify: 'ハッシュチェーン検証',
};

/** 役割ごとの Construct ID 接頭辞。 */
const HANDLER_ID_PREFIX: Readonly<Record<HandlerKind, string>> = {
  ingest: 'Ingest',
  search: 'Search',
  export: 'Export',
  verify: 'Verify',
};

/** Lambda 実行ロールに付与する CloudWatch Logs の権限（対象ロググループ限定）。 */
function grantLogWrite(role: iam.Role, logGroup: logs.ILogGroup): void {
  role.addToPolicy(
    new iam.PolicyStatement({
      actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
      resources: [`${logGroup.logGroupArn}:*`],
    }),
  );
}

/**
 * カスタマー管理 KMS キーに対する権限（キー ARN 限定）。
 *
 * 書き込み側はデータキー生成（`kms:GenerateDataKey`）と復号、
 * 読み取り専用側は復号（`kms:Decrypt`）だけを付与する。
 */
function grantKeyUsage(role: iam.Role, storage: StorageStack, actions: readonly string[]): void {
  role.addToPolicy(
    new iam.PolicyStatement({
      actions: [...actions],
      resources: [storage.encryptionKey.keyArn],
    }),
  );
}

/** 証憑・メタデータの読み取り権限（オブジェクト限定 + バケット一覧）。 */
function grantArchiveRead(role: iam.Role, storage: StorageStack): void {
  const bucket = storage.archiveBucket;
  role.addToPolicy(
    new iam.PolicyStatement({
      actions: ['s3:GetObject', 's3:GetObjectVersion'],
      resources: [bucket.arnForObjects('objects/*'), bucket.arnForObjects('metadata/*')],
    }),
  );
  role.addToPolicy(
    new iam.PolicyStatement({
      actions: ['s3:ListBucket'],
      resources: [bucket.bucketArn],
    }),
  );
  grantKeyUsage(role, storage, ['kms:Decrypt']);
}

/** 索引テーブルの読み取り権限（Query / GetItem。Scan は与えない）。 */
function grantIndexRead(role: iam.Role, storage: StorageStack): void {
  role.addToPolicy(
    new iam.PolicyStatement({
      actions: ['dynamodb:GetItem', 'dynamodb:Query'],
      resources: [storage.voucherIndexTable.tableArn],
    }),
  );
}

/**
 * 4 つの Lambda と最小権限の実行ロール、デッドレターキュー、監視アラームを構築する。
 *
 * 依存方向は `dencho-compute` -> `dencho-storage` の一方向のみで、
 * 循環参照は生じない。
 */
export class ComputeStack extends cdk.Stack {
  /** 4 つの Lambda 関数。 */
  readonly functions: ComputeFunctions;

  /** 関数専用ロググループ（保持期間 731 日）。 */
  readonly logGroups: Readonly<Record<HandlerKind, logs.ILogGroup>>;

  /** 取り込み Lambda の非同期呼び出し失敗を退避する SQS キュー。 */
  readonly deadLetterQueue: sqs.IQueue;

  /** Lambda ハンドラ成果物のディレクトリ。 */
  private readonly handlersDir: string;

  constructor(scope: Construct, id: string, props: ComputeStackProps) {
    super(scope, id, {
      ...props,
      description: props.description ?? 'dencho-archive: サーバレス実行層（Lambda + SQS DLQ + CloudWatch アラーム）',
    });

    const storage = props.storage;
    this.handlersDir = props.handlersDir;

    this.deadLetterQueue = new sqs.Queue(this, 'IngestDeadLetterQueue', {
      queueName: 'dencho-ingest-dlq',
      // 失敗イベントを 14 日間保持し、原因調査と再処理の猶予を作る。
      retentionPeriod: cdk.Duration.days(14),
      encryption: sqs.QueueEncryption.KMS_MANAGED,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const archiveEnvironment: Record<string, string> = {
      ARCHIVE_BUCKET: storage.archiveBucket.bucketName,
    };

    const ingest = this.createHandler({
      kind: 'ingest',
      handler: 'ingest.handler',
      timeoutSeconds: 60,
      memorySize: 1024,
      description: `${HANDLER_LABELS.ingest}（タイムスタンプ付与 + 台帳追記）`,
      environment: {
        ...archiveEnvironment,
        VOUCHER_INDEX_TABLE: storage.voucherIndexTable.tableName,
        AUDIT_LOG_TABLE: storage.auditLogTable.tableName,
        CHAIN_CHECKPOINTS_TABLE: storage.chainCheckpointsTable.tableName,
      },
      deadLetterQueue: this.deadLetterQueue,
    });

    const search = this.createHandler({
      kind: 'search',
      handler: 'search.handler',
      timeoutSeconds: 15,
      memorySize: 512,
      description: `${HANDLER_LABELS.search}（取引年月日・金額・取引先の 3 項目）`,
      environment: {
        ...archiveEnvironment,
        VOUCHER_INDEX_TABLE: storage.voucherIndexTable.tableName,
      },
    });

    const exportFunction = this.createHandler({
      kind: 'export',
      handler: 'export.handler',
      timeoutSeconds: 60,
      memorySize: 1024,
      description: `${HANDLER_LABELS.export}（税務調査の「ダウンロードの求め」対応）`,
      environment: {
        ...archiveEnvironment,
        VOUCHER_INDEX_TABLE: storage.voucherIndexTable.tableName,
      },
    });

    const verify = this.createHandler({
      kind: 'verify',
      handler: 'verify.handler',
      timeoutSeconds: 300,
      memorySize: 1024,
      description: `${HANDLER_LABELS.verify}（毎日 03:00 JST に EventBridge から起動）`,
      environment: {
        ...archiveEnvironment,
        VOUCHER_INDEX_TABLE: storage.voucherIndexTable.tableName,
        CHAIN_CHECKPOINTS_TABLE: storage.chainCheckpointsTable.tableName,
      },
    });

    this.functions = {
      ingest: ingest.fn,
      search: search.fn,
      export: exportFunction.fn,
      verify: verify.fn,
    };

    this.logGroups = {
      ingest: ingest.logGroup,
      search: search.logGroup,
      export: exportFunction.logGroup,
      verify: verify.logGroup,
    };

    // --- 最小権限の付与（関数ごとに必要な操作だけ） ---
    // 取り込み: 新規オブジェクトの追加と、索引・監査ログへの追記のみ。
    // 削除（s3:DeleteObject）・ACL・バケット管理系は一切与えない。
    ingest.role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['s3:PutObject'],
        resources: [
          storage.archiveBucket.arnForObjects('objects/*'),
          storage.archiveBucket.arnForObjects('metadata/*'),
        ],
      }),
    );
    ingest.role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:PutItem'],
        resources: [storage.voucherIndexTable.tableArn, storage.auditLogTable.tableArn],
      }),
    );
    grantKeyUsage(ingest.role, storage, ['kms:Decrypt', 'kms:GenerateDataKey']);
    grantLogWrite(ingest.role, ingest.logGroup);

    // 検索: 読み取り専用。
    grantArchiveRead(search.role, storage);
    grantIndexRead(search.role, storage);
    grantLogWrite(search.role, search.logGroup);

    // 出力: 読み取り専用。税務調査の全件ダウンロード要求に備えて Scan も
    // 許可するが、テーブル単位に限定する（ワイルドカードは使わない）。
    grantArchiveRead(exportFunction.role, storage);
    grantIndexRead(exportFunction.role, storage);
    exportFunction.role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:Scan'],
        resources: [storage.voucherIndexTable.tableArn],
      }),
    );
    grantLogWrite(exportFunction.role, exportFunction.logGroup);

    // 検証: 証憑は読み取り専用。チェックポイントの照合（ConditionCheck）と
    // 検証結果の記録（PutItem）だけを、チェックポイント表に限定して許可する。
    grantArchiveRead(verify.role, storage);
    verify.role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:GetItem', 'dynamodb:Query', 'dynamodb:ConditionCheckItem'],
        resources: [storage.voucherIndexTable.tableArn, storage.chainCheckpointsTable.tableArn],
      }),
    );
    verify.role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:PutItem'],
        resources: [storage.chainCheckpointsTable.tableArn],
      }),
    );
    grantLogWrite(verify.role, verify.logGroup);

    // --- 監視: 各関数の Errors / Throttles と DLQ 滞留 ---
    addFunctionAlarms(this, 'ingest', ingest.fn);
    addFunctionAlarms(this, 'search', search.fn);
    addFunctionAlarms(this, 'export', exportFunction.fn);
    addFunctionAlarms(this, 'verify', verify.fn);

    new cloudwatch.Alarm(this, 'IngestDeadLetterQueueAlarm', {
      alarmName: 'dencho-ingest-dlq-not-empty',
      alarmDescription: '取り込み Lambda の非同期呼び出しがデッドレターキューへ退避されました',
      metric: this.deadLetterQueue.metricApproximateNumberOfMessagesVisible({
        period: cdk.Duration.minutes(5),
        statistic: 'Maximum',
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
  }

  /**
   * 1 つの Lambda 関数・専用ロググループ・最小権限の実行ロールを生成する。
   *
   * 実行ロールには AWS マネージドポリシーを付けず、CloudWatch Logs への
   * 書き込み権限だけをこの時点で付与する。
   */
  private createHandler(spec: HandlerFunctionSpec): HandlerResources {
    const prefix = HANDLER_ID_PREFIX[spec.kind];

    const logGroup = new logs.LogGroup(this, `${prefix}LogGroup`, {
      logGroupName: `/aws/lambda/dencho-${spec.kind}`,
      // 731 日 = CloudWatch Logs の実質上限（10 年未満の最長保持）。
      retention: logs.RetentionDays.TWO_YEARS,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const role = new iam.Role(this, `${prefix}Role`, {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      // IAM ロールの description は ASCII/Latin-1 のみ許可されるため英語で書く。
      description: `Execution role for the ${spec.kind} Lambda (least privilege, no wildcard resources)`,
    });

    const fn = new lambda.Function(this, `${prefix}Function`, {
      functionName: `dencho-${spec.kind}`,
      description: spec.description,
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      handler: spec.handler,
      code: lambda.Code.fromAsset(this.handlersDir),
      timeout: cdk.Duration.seconds(spec.timeoutSeconds),
      memorySize: spec.memorySize,
      environment: spec.environment,
      role,
      logGroup,
      ...(spec.deadLetterQueue === undefined
        ? {}
        : {
            deadLetterQueue: spec.deadLetterQueue,
            retryAttempts: 2,
            maxEventAge: cdk.Duration.hours(6),
          }),
    });

    return { fn, logGroup, role };
  }
}

/**
 * 1 関数分の Errors / Throttles アラームを追加する。
 *
 * 両アラームとも欠測は notBreaching とし、平常時のノイズを避ける。
 */
function addFunctionAlarms(scope: Construct, kind: HandlerKind, fn: lambda.IFunction): void {
  const prefix = HANDLER_ID_PREFIX[kind];
  const label = HANDLER_LABELS[kind];

  new cloudwatch.Alarm(scope, `${prefix}ErrorsAlarm`, {
    alarmName: `dencho-${kind}-errors`,
    alarmDescription: `${label} Lambda でエラーが発生しました`,
    metric: fn.metricErrors({ period: cdk.Duration.minutes(5), statistic: 'Sum' }),
    threshold: 1,
    evaluationPeriods: 1,
    comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
  });

  new cloudwatch.Alarm(scope, `${prefix}ThrottlesAlarm`, {
    alarmName: `dencho-${kind}-throttles`,
    alarmDescription: `${label} Lambda がスロットリングされました`,
    metric: fn.metricThrottles({ period: cdk.Duration.minutes(5), statistic: 'Sum' }),
    threshold: 1,
    evaluationPeriods: 1,
    comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
  });
}
