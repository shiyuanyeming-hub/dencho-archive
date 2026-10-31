/**
 * 適合性検証テスト用のフィクスチャ。
 *
 * 実装（`src/app/**` や `src/adapters/**`）には依存せず、`src/core/types.ts` の
 * 型どおりの値をリテラルで組み立てる。これにより、適合性エンジンが
 * アプリケーション層の変更に引きずられずに検証できる。
 */
import type {
  ArchiveConfig,
  ArchiveManifest,
  ArchiveView,
  AuditReport,
  ChainVerification,
  CfnResource,
  CfnTemplate,
  ComplianceRule,
  InfraSnapshot,
  IsoInstant,
  RuleContext,
  RuleEvaluation,
  RuleResult,
  SearchCapability,
  StoredVoucher,
  TimestampToken,
} from '../../src/core/types.js';
import { sha256HexText } from '../../src/core/hash.js';
import { BUILTIN_RULES } from '../../src/compliance/index.js';

/** テストで共通の判定基準時刻（JST）。 */
export const NOW: IsoInstant = '2026-10-31T18:00:00+09:00';

/** アーカイブ ID の既定値。 */
export const ARCHIVE_ID = 'arch-test';

/** 内容アドレス用の決定的な SHA-256 を組み立てる。 */
export function hashOf(label: string): string {
  return sha256HexText(`fixture:${label}`);
}

/** リソースを 1 つも含まないインフラ定義（リソース欠落時の挙動検証用）。 */
export const EMPTY_INFRA: InfraSnapshot = {
  stacks: { 'dencho-storage': { Resources: {} } },
};

/**
 * タイムスタンプトークンのフィクスチャを作る。
 *
 * 既定では「受領日の 28 日後に付与」という期限内のトークンになる。
 */
export function makeTimestamp(overrides: Partial<TimestampToken> = {}): TimestampToken {
  return {
    authority: 'test-tsa',
    serial: '0001',
    digestAlgorithm: 'sha256',
    digest: hashOf('timestamp-digest'),
    generatedAt: '2026-10-30T10:00:00+09:00',
    signature: 'test-signature-0001',
    ...overrides,
  };
}

/** 保存済み証憑のフィクスチャを作る（既定は真実性ルールを満たす値）。 */
export function makeVoucher(overrides: Partial<StoredVoucher> = {}): StoredVoucher {
  return {
    voucherId: 'v-001',
    sequence: 1,
    transactionDate: '2026-10-01',
    amountYen: 11000,
    counterpartyName: '株式会社サンプル商事',
    counterpartyNormalized: 'サンプル商事',
    documentType: 'invoice',
    originalFileName: 'invoice-001.pdf',
    mediaType: 'application/pdf',
    objectKey: 'objects/aa/bb/content-001',
    contentSha256: hashOf('content-001'),
    metadataSha256: hashOf('metadata-001'),
    entryHash: hashOf('entry-001'),
    recordedAt: '2026-10-30T10:00:00+09:00',
    receivedAt: '2026-10-02T09:00:00+09:00',
    timestamp: makeTimestamp(),
    tags: [],
    note: null,
    ...overrides,
  };
}

/**
 * 連番の証憑フィクスチャをまとめて作る。
 *
 * `overrides` は 0 始まりのインデックスを受け取り、値の差分だけを返す。
 */
export function makeVouchers(
  count: number,
  overrides: (index: number) => Partial<StoredVoucher> = () => ({}),
): readonly StoredVoucher[] {
  const vouchers: StoredVoucher[] = [];
  for (let index = 0; index < count; index += 1) {
    vouchers.push(
      makeVoucher({
        voucherId: `v-${String(index + 1).padStart(3, '0')}`,
        sequence: index + 1,
        ...overrides(index),
      }),
    );
  }
  return vouchers;
}

/** チェーン検証結果のフィクスチャを作る（既定は整合）。 */
export function makeChain(overrides: Partial<ChainVerification> = {}): ChainVerification {
  return {
    status: 'intact',
    checkedEntries: 2,
    headHash: hashOf('head'),
    checkpointsVerified: true,
    ...overrides,
  };
}

/** 検索要件の充足状況のフィクスチャを作る（既定はすべて充足）。 */
export function makeCapability(overrides: Partial<SearchCapability> = {}): SearchCapability {
  return {
    searchableFields: ['transactionDate', 'amount', 'counterparty'],
    supportsDateRange: true,
    supportsAmountRange: true,
    supportsCounterparty: true,
    twoFieldCombinations: [
      '取引年月日+取引金額',
      '取引年月日+取引先',
      '取引金額+取引先',
    ],
    exportFormats: ['csv', 'json'],
    indexes: [
      'by-date',
      'by-amount',
      'by-counterparty',
      'by-counterparty-date',
      'by-counterparty-amount',
    ],
    ...overrides,
  };
}

/** 台帳マニフェストのフィクスチャを作る。 */
export function makeManifest(overrides: Partial<ArchiveManifest> = {}): ArchiveManifest {
  return {
    schemaVersion: 1,
    archiveId: ARCHIVE_ID,
    createdAt: '2026-10-01T00:00:00+09:00',
    retentionYears: 7,
    worm: false,
    entries: [],
    checkpoints: [],
    ...overrides,
  };
}

/** アーカイブ設定のフィクスチャを作る（既定は電帳法の必須要件を満たす値）。 */
export function makeConfig(overrides: Partial<ArchiveConfig> = {}): ArchiveConfig {
  return {
    archiveId: ARCHIVE_ID,
    retentionYears: 7,
    timestampMaxDelayDays: 62,
    worm: false,
    requireTimestamp: true,
    ...overrides,
  };
}

/** アーカイブ状態（ArchiveView）のフィクスチャを作る。 */
export interface ArchiveViewOverrides {
  /** 台帳マニフェストの差分。 */
  readonly manifest?: Partial<ArchiveManifest>;
  /** 保存済み証憑（省略時は 2 件の正常な証憑）。 */
  readonly vouchers?: readonly StoredVoucher[];
  /** チェーン検証結果の差分。 */
  readonly chain?: Partial<ChainVerification>;
  /** 検索要件の充足状況の差分。 */
  readonly capability?: Partial<SearchCapability>;
}

/** アーカイブ状態（ArchiveView）のフィクスチャを作る。 */
export function makeArchiveView(overrides: ArchiveViewOverrides = {}): ArchiveView {
  const vouchers = overrides.vouchers ?? makeVouchers(2);
  return {
    manifest: makeManifest(overrides.manifest),
    vouchers,
    chain: makeChain({ checkedEntries: vouchers.length, ...overrides.chain }),
    capability: makeCapability(overrides.capability),
  };
}

/** ルール評価に渡す文脈の差分。 */
export interface RuleContextOverrides {
  /** アーカイブ状態（省略時は正常なアーカイブ）。 */
  readonly archive?: ArchiveView;
  /** インフラ定義（未指定ならインフラ系ルールは not-applicable）。 */
  readonly infra?: InfraSnapshot | undefined;
  /** 判定基準時刻。 */
  readonly now?: IsoInstant;
  /** アーカイブ設定の差分。 */
  readonly config?: Partial<ArchiveConfig>;
}

/** ルール評価に渡す文脈のフィクスチャを作る。 */
export function makeContext(overrides: RuleContextOverrides = {}): RuleContext {
  return {
    archive: overrides.archive ?? makeArchiveView(),
    infra: overrides.infra,
    now: overrides.now ?? NOW,
    config: makeConfig(overrides.config ?? {}),
  };
}

/** インフラフィクスチャの生成オプション。 */
export interface InfraFixtureOptions {
  /** アーカイブ用 S3 バケットを定義するか（既定 true）。 */
  readonly includeBucket?: boolean;
  /** Object Lock を有効にするか（既定 true）。 */
  readonly objectLockEnabled?: boolean;
  /** ObjectLockConfiguration を定義するか（既定 true）。 */
  readonly objectLockConfigured?: boolean;
  /** Object Lock のデフォルト保持モード（既定 COMPLIANCE）。 */
  readonly retentionMode?: string;
  /** Object Lock のデフォルト保持日数（既定 2557）。 */
  readonly retentionDays?: number;
  /** バージョニングの状態（既定 Enabled）。 */
  readonly versioningStatus?: string;
  /** パブリックアクセスブロック（既定 block-all）。 */
  readonly publicAccess?: 'block-all' | 'open' | 'absent';
  /** デフォルト暗号化（既定 aws:kms）。 */
  readonly encryption?: 'aws:kms' | 'AES256' | 'none';
  /** バケットポリシーによる TLS 強制（既定 enforced）。 */
  readonly tlsPolicy?: 'enforced' | 'no-condition' | 'absent';
  /** CloudTrail トレイルを定義するか（既定 true）。 */
  readonly includeTrail?: boolean;
  /** CloudTrail が S3 データイベントを記録するか（既定 true）。 */
  readonly trailDataEvents?: boolean;
  /** CloudTrail のセレクタ形式（既定 event-selectors）。 */
  readonly trailSelectorStyle?: 'event-selectors' | 'advanced';
  /** DynamoDB の PITR（既定 true）。 */
  readonly pitr?: boolean;
  /** 定義する DynamoDB テーブル数（既定 3）。 */
  readonly tables?: number;
  /** KMS キーを定義するか（既定 true）。 */
  readonly includeKmsKey?: boolean;
  /** KMS キーローテーション（既定 true）。 */
  readonly kmsRotation?: boolean;
  /** 整合性検証失敗の CloudWatch アラームを定義するか（既定 true）。 */
  readonly chainAlarm?: boolean;
  /** CloudTrail ログ用バケットを定義するか（既定 true）。 */
  readonly includeTrailLogBucket?: boolean;
}

/** DynamoDB テーブルの論理 ID（実インフラに合わせた並び）。 */
const TABLE_LOGICAL_IDS = ['VoucherIndexTable', 'AuditLogTable', 'ChainCheckpointTable'] as const;

/**
 * 正常な CDK 合成結果に近いインフラフィクスチャを作る。
 *
 * 既定では「電帳法のインフラ要件をすべて満たす」状態になる。オプションで
 * 1 項目だけ壊し、各 INF ルールの fail を検証する。
 * CloudTrail ログ用バケット（Object Lock なし）を併存させ、アーカイブ用
 * バケットの選択（スタック名・論理 ID）が正しく働くことも確認できる形にしている。
 */
export function makeInfra(options: InfraFixtureOptions = {}): InfraSnapshot {
  const includeBucket = options.includeBucket ?? true;
  const objectLockEnabled = options.objectLockEnabled ?? true;
  const objectLockConfigured = options.objectLockConfigured ?? true;
  const retentionMode = options.retentionMode ?? 'COMPLIANCE';
  const retentionDays = options.retentionDays ?? 2557;
  const versioningStatus = options.versioningStatus ?? 'Enabled';
  const publicAccess = options.publicAccess ?? 'block-all';
  const encryption = options.encryption ?? 'aws:kms';
  const tlsPolicy = options.tlsPolicy ?? 'enforced';
  const includeTrail = options.includeTrail ?? true;
  const trailDataEvents = options.trailDataEvents ?? true;
  const trailSelectorStyle = options.trailSelectorStyle ?? 'event-selectors';
  const pitr = options.pitr ?? true;
  const tableCount = options.tables ?? 3;
  const includeKmsKey = options.includeKmsKey ?? true;
  const kmsRotation = options.kmsRotation ?? true;
  const chainAlarm = options.chainAlarm ?? true;
  const includeTrailLogBucket = options.includeTrailLogBucket ?? true;

  // --- dencho-storage -----------------------------------------------------
  const storageResources: Record<string, CfnResource> = {};
  if (includeBucket) {
    const bucketProperties: Record<string, unknown> = {
      ObjectLockEnabled: objectLockEnabled,
      VersioningConfiguration: { Status: versioningStatus },
    };
    if (objectLockConfigured) {
      bucketProperties['ObjectLockConfiguration'] = {
        ObjectLockEnabled: 'Enabled',
        Rule: { DefaultRetention: { Mode: retentionMode, Days: retentionDays } },
      };
    }
    if (publicAccess !== 'absent') {
      const blockAll = publicAccess === 'block-all';
      bucketProperties['PublicAccessBlockConfiguration'] = {
        BlockPublicAcls: blockAll,
        BlockPublicPolicy: blockAll,
        IgnorePublicAcls: blockAll,
        RestrictPublicBuckets: blockAll,
      };
    }
    if (encryption !== 'none') {
      bucketProperties['BucketEncryption'] = {
        ServerSideEncryptionConfiguration: [
          {
            ServerSideEncryptionByDefault: {
              SSEAlgorithm: encryption,
              ...(encryption === 'aws:kms' ? { KMSMasterKeyID: { 'Fn::GetAtt': ['ArchiveKey', 'Arn'] } } : {}),
            },
            BucketKeyEnabled: true,
          },
        ],
      };
    }
    storageResources['ArchiveBucket'] = { Type: 'AWS::S3::Bucket', Properties: bucketProperties };

    if (tlsPolicy !== 'absent') {
      const statement: Record<string, unknown> = {
        Sid: 'DenyInsecureTransport',
        Effect: 'Deny',
        Principal: { AWS: '*' },
        Action: 's3:*',
        Resource: ['arn:aws:s3:::dencho-archive/*'],
      };
      if (tlsPolicy === 'enforced') {
        statement['Condition'] = { Bool: { 'aws:SecureTransport': 'false' } };
      }
      storageResources['ArchiveBucketPolicy'] = {
        Type: 'AWS::S3::BucketPolicy',
        Properties: {
          Bucket: { Ref: 'ArchiveBucket' },
          PolicyDocument: { Version: '2012-10-17', Statement: [statement] },
        },
      };
    }
  }

  for (let index = 0; index < tableCount; index += 1) {
    const logicalId = TABLE_LOGICAL_IDS[index] ?? `ExtraTable${String(index)}`;
    storageResources[logicalId] = {
      Type: 'AWS::DynamoDB::Table',
      Properties: {
        BillingMode: 'PAY_PER_REQUEST',
        PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: pitr },
        SSESpecification: { SSEEnabled: true },
      },
    };
  }

  if (includeKmsKey) {
    storageResources['ArchiveKey'] = {
      Type: 'AWS::KMS::Key',
      Properties: { EnableKeyRotation: kmsRotation, KeyUsage: 'ENCRYPT_DECRYPT' },
    };
  }

  // --- dencho-compute -----------------------------------------------------
  const computeResources: Record<string, CfnResource> = {
    IngestFunctionErrorsAlarm: {
      Type: 'AWS::CloudWatch::Alarm',
      Properties: {
        Namespace: 'AWS/Lambda',
        MetricName: 'Errors',
        ComparisonOperator: 'GreaterThanThreshold',
        EvaluationPeriods: 1,
        Threshold: 1,
        Statistic: 'Sum',
      },
    },
    IngestFunctionThrottlesAlarm: {
      Type: 'AWS::CloudWatch::Alarm',
      Properties: {
        Namespace: 'AWS/Lambda',
        MetricName: 'Throttles',
        ComparisonOperator: 'GreaterThanThreshold',
        EvaluationPeriods: 1,
        Threshold: 1,
        Statistic: 'Sum',
      },
    },
  };
  if (chainAlarm) {
    computeResources['ChainVerificationFailureAlarm'] = {
      Type: 'AWS::CloudWatch::Alarm',
      Properties: {
        Namespace: 'DenchoArchive',
        MetricName: 'ChainVerificationFailure',
        ComparisonOperator: 'GreaterThanThreshold',
        EvaluationPeriods: 1,
        Threshold: 1,
        Statistic: 'Sum',
      },
    };
  }

  // --- dencho-guardrails --------------------------------------------------
  const guardrailResources: Record<string, CfnResource> = {};
  if (includeTrailLogBucket) {
    guardrailResources['CloudTrailLogsBucket'] = {
      Type: 'AWS::S3::Bucket',
      Properties: {
        VersioningConfiguration: { Status: 'Enabled' },
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          BlockPublicPolicy: true,
          IgnorePublicAcls: true,
          RestrictPublicBuckets: true,
        },
        BucketEncryption: {
          ServerSideEncryptionConfiguration: [
            { ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } },
          ],
        },
      },
    };
  }
  if (includeTrail) {
    const selectors =
      trailSelectorStyle === 'advanced'
        ? {
            AdvancedEventSelectors: [
              {
                Name: 'S3ObjectEvents',
                FieldSelectors: [
                  ...(trailDataEvents
                    ? [{ Field: 'resources.type', Equals: ['AWS::S3::Object'] }]
                    : [{ Field: 'eventCategory', Equals: ['Management'] }]),
                ],
              },
            ],
          }
        : {
            EventSelectors: [
              { ReadWriteType: 'All', IncludeManagementEvents: true, DataResources: [] },
              {
                ReadWriteType: 'All',
                IncludeManagementEvents: true,
                DataResources: trailDataEvents
                  ? [{ Type: 'AWS::S3::Object', Values: ['arn:aws:s3:::dencho-archive/'] }]
                  : [],
              },
            ],
          };
    guardrailResources['ArchiveTrail'] = {
      Type: 'AWS::CloudTrail::Trail',
      Properties: {
        IsMultiRegionTrail: true,
        IncludeGlobalServiceEvents: true,
        EnableLogFileValidation: true,
        IsLogging: true,
        S3BucketName: includeTrailLogBucket ? { Ref: 'CloudTrailLogsBucket' } : 'dencho-cloudtrail-logs',
        ...selectors,
      },
    };
  }

  const stacks: Record<string, CfnTemplate> = {
    'dencho-storage': { AWSTemplateFormatVersion: '2010-09-09', Resources: storageResources },
    'dencho-compute': { AWSTemplateFormatVersion: '2010-09-09', Resources: computeResources },
    'dencho-guardrails': { AWSTemplateFormatVersion: '2010-09-09', Resources: guardrailResources },
  };
  return { stacks };
}

/** 指定した ID のビルトインルール定義を返す（存在しなければテスト失敗）。 */
export function ruleById(id: string): ComplianceRule {
  const rule = BUILTIN_RULES.find((candidate) => candidate.id === id);
  if (rule === undefined) {
    throw new Error(`存在しないルール ID です: ${id}`);
  }
  return rule;
}

/** ビルトインルール 1 件を評価する。 */
export async function evaluateRule(id: string, context: RuleContext): Promise<RuleEvaluation> {
  return await ruleById(id).evaluate(context);
}

/** 証跡を 1 つの文字列にまとめる（`toContain` での検証用）。 */
export function evidenceText(evaluation: RuleEvaluation): string {
  return evaluation.evidence.map((item) => `${item.subject}: ${item.detail}`).join('\n');
}

/** 監査レポート用のルール結果フィクスチャを作る。 */
export function makeRuleResult(overrides: Partial<RuleResult> = {}): RuleResult {
  return {
    ruleId: 'TEST-01',
    title: 'テスト用ルール',
    category: 'authenticity',
    severity: 'mandatory',
    status: 'pass',
    evidence: [],
    ...overrides,
  };
}

/** 監査レポートのフィクスチャを作る（集計は渡した results から自動計算）。 */
export function makeReport(overrides: Partial<AuditReport> = {}): AuditReport {
  const results = overrides.results ?? [makeRuleResult()];
  const summary = {
    total: results.length,
    passed: results.filter((result) => result.status === 'pass').length,
    failed: results.filter((result) => result.status === 'fail').length,
    notApplicable: results.filter((result) => result.status === 'not-applicable').length,
    errored: results.filter((result) => result.status === 'error').length,
  };
  return {
    schemaVersion: 1,
    archiveId: ARCHIVE_ID,
    generatedAt: NOW,
    verdict: 'compliant',
    summary,
    scope: { vouchers: 2, infraStacks: 3, checkedEntries: 2 },
    results,
    ...overrides,
  };
}
