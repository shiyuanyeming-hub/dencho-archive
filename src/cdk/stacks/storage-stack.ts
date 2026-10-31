/**
 * dencho-storage スタック。
 *
 * 電子帳簿保存法（電帳法）が求める「真実性の確保」と「7 年保存」を、
 * クラウド側の強制力で担保する保存層である。
 *
 * - 証憑データは S3 の Object Lock（COMPLIANCE モード・2557 日）で WORM 保存する。
 *   削除・上書きは保存期間中、root を含むどの主体からもできない。
 * - 台帳・メタデータ・チェックポイントは DynamoDB に置き、PITR と削除保護を有効にする。
 * - すべての保存データはカスタマー管理の KMS キーで暗号化し、キーローテーションを有効にする。
 * - CloudFormation の RemovalPolicy は RETAIN。スタック削除でも証憑を消さない。
 */
import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as s3 from 'aws-cdk-lib/aws-s3';
import type { Construct } from 'constructs';

/**
 * Object Lock の既定保持日数。
 *
 * 電帳法の保存期間は 7 年。7 年を日数で表すと、うるう年を 2 回（例: 2024/2028、
 * 起算日によっては 3 回）またぐため単純な 365×7=2555 では不足し得る。
 * 余裕を見て 2557 日（365 日 × 7 年 + うるう日 2 日）を既定値とする。
 */
export const RETENTION_DAYS = 2557;

/** `dencho-storage` スタックのプロパティ。 */
export interface StorageStackProps extends cdk.StackProps {
  /** 監査ログ用 KMS キーのエイリアス。省略時は `alias/dencho-archive`。 */
  readonly keyAlias?: string;
}

/**
 * WORM 保存層（S3 + KMS + DynamoDB）を構築するスタック。
 *
 * 他スタックは本スタックの公開プロパティ（バケット / テーブル / キー）を
 * 受け取って IAM ポリシーや連携設定を組み立てる。逆方向の依存は作らない。
 */
export class StorageStack extends cdk.Stack {
  /** 証憑データ本体とメタデータを WORM 保存する S3 バケット。 */
  readonly archiveBucket: s3.IBucket;

  /** 保存データを暗号化するカスタマー管理の KMS キー。 */
  readonly encryptionKey: kms.IKey;

  /** 検索要件を満たすための索引テーブル（pk/sk）。 */
  readonly voucherIndexTable: dynamodb.ITable;

  /** 追記専用の監査ログテーブル（取り込み・検索・出力の操作履歴）。 */
  readonly auditLogTable: dynamodb.ITable;

  /** ハッシュチェーンの検証済みチェックポイントを保持するテーブル。 */
  readonly chainCheckpointsTable: dynamodb.ITable;

  constructor(scope: Construct, id: string, props: StorageStackProps = {}) {
    super(scope, id, {
      ...props,
      description: props.description ?? 'dencho-archive: WORM 保存層（S3 Object Lock + KMS + DynamoDB）',
    });

    this.encryptionKey = new kms.Key(this, 'ArchiveKey', {
      alias: props.keyAlias ?? 'alias/dencho-archive',
      description: 'dencho-archive の証憑・台帳・メタデータを保存時に暗号化するカスタマー管理キー',
      enableKeyRotation: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    this.archiveBucket = new s3.Bucket(this, 'ArchiveBucket', {
      // Object Lock は「作成時のみ有効化」可能。バージョニングは必須要件。
      versioned: true,
      objectLockEnabled: true,
      objectLockDefaultRetention: s3.ObjectLockRetention.compliance(cdk.Duration.days(RETENTION_DAYS)),
      // 公開アクセスは全面ブロック。TLS を強制する（BucketPolicy の Deny）。
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: this.encryptionKey,
      bucketKeyEnabled: true,
      // ACL を無効化し、バケット所有者に所有権を一本化する。
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      // スタック削除でも証憑を消さない。autoDeleteObjects は WORM と矛盾するため使わない。
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    this.voucherIndexTable = createAuditTable(this, 'VoucherIndexTable', {
      tableName: 'dencho-voucher-index',
      description: '証憑の検索索引（取引年月日 / 金額 / 取引先）',
    });

    this.auditLogTable = createAuditTable(this, 'AuditLogTable', {
      tableName: 'dencho-audit-log',
      description: '追記専用の監査ログ（取り込み・検索・出力・検証の操作履歴）',
      // 追記専用を後から検証できるよう、ストリームで変更履歴を残す。
      streamViewType: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
    });

    this.chainCheckpointsTable = createAuditTable(this, 'ChainCheckpointsTable', {
      tableName: 'dencho-chain-checkpoints',
      description: 'ハッシュチェーンの検証済みチェックポイント（sequence -> entryHash）',
    });
  }
}

/** DynamoDB テーブル生成オプション。 */
interface AuditTableOptions {
  /** 物理テーブル名。 */
  readonly tableName: string;
  /** テーブルの用途説明。 */
  readonly description: string;
  /** DynamoDB ストリームの種類。省略時はストリームなし。 */
  readonly streamViewType?: dynamodb.StreamViewType;
}

/**
 * 監査対象の DynamoDB テーブルを共通設定で生成する。
 *
 * 監査証跡として前提を揃えるため、全テーブルで次を必須にする:
 * - オンデマンド課金（キャパシティ計画なしで小規模運用できる）
 * - ポイントインタイムリカバリ（PITR）
 * - AWS マネージドキーによる保存時暗号化
 * - 削除保護と RemovalPolicy.RETAIN
 */
function createAuditTable(scope: Construct, id: string, options: AuditTableOptions): dynamodb.Table {
  return new dynamodb.Table(scope, id, {
    tableName: options.tableName,
    partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
    sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
    billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    encryption: dynamodb.TableEncryption.AWS_MANAGED,
    deletionProtection: true,
    removalPolicy: cdk.RemovalPolicy.RETAIN,
    ...(options.streamViewType === undefined ? {} : { stream: options.streamViewType }),
  });
}
