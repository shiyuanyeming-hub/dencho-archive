/**
 * インフラ（CDK が合成した CloudFormation）に対する監査・真実性ルール。
 *
 * ここで扱うのは「AWS 側の設定が、電帳法の要件を技術的に支えているか」である。
 * 入力は `InfraSnapshot`（スタック名 → CloudFormation テンプレート）であり、
 * アーカイブの状態（証憑・台帳）は参照しない。
 *
 * 入力は CDK のバージョンや記述方法で揺れるため、読み取りは `cfn.ts` の
 * 寛容なヘルパーに任せ、リソースが無い場合は fail とし証跡に
 * 「リソースが見つかりません」を残す（例外は投げない）。
 *
 * `context.infra` が undefined の場合は、インフラを監査対象にしていないものとして
 * すべて `not-applicable` を返す（必須ルールの not-applicable は総合判定を妨げない）。
 */
import type {
  ComplianceRule,
  EvidenceItem,
  RuleContext,
  RuleEvaluation,
} from '../../core/types.js';
import {
  asArray,
  asBoolean,
  asRecord,
  asString,
  enabledLabel,
  findArchiveBucket,
  findResources,
  isObjectLockEnabled,
  missingResourceEvidence,
  propertiesOf,
  readObjectLockRetention,
  readProperty,
  resourceSubject,
  type ResourceLocation,
} from './cfn.js';

/** S3 Object Lock の要件日数（7 年相当）。 */
const OBJECT_LOCK_RETENTION_DAYS = 2557;

/** パブリックアクセスブロックの 4 つのフラグ。 */
const PUBLIC_ACCESS_BLOCK_KEYS = [
  'BlockPublicAcls',
  'BlockPublicPolicy',
  'IgnorePublicAcls',
  'RestrictPublicBuckets',
] as const;

/** AWS 公式ドキュメントへの参照先（可用性の高い固定 URL のみを使う）。 */
const AWS_REFERENCES = {
  objectLock: 'https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-lock.html',
  versioning: 'https://docs.aws.amazon.com/AmazonS3/latest/userguide/Versioning.html',
  publicAccess:
    'https://docs.aws.amazon.com/AmazonS3/latest/userguide/access-control-block-public-access.html',
  encryption: 'https://docs.aws.amazon.com/AmazonS3/latest/userguide/UsingKMSEncryption.html',
  tls: 'https://docs.aws.amazon.com/AmazonS3/latest/userguide/security-best-practices.html',
  cloudTrail:
    'https://docs.aws.amazon.com/awscloudtrail/latest/userguide/logging-data-events-with-cloudtrail.html',
  dynamoDbPitr:
    'https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/PointInTimeRecovery.html',
  kmsRotation: 'https://docs.aws.amazon.com/kms/latest/developerguide/rotate-keys.html',
  cloudWatchAlarm:
    'https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/AlarmThatSendsEmail.html',
} as const;

/** インフラ定義が無い場合の共通評価結果。 */
function notApplicableEvaluation(): RuleEvaluation {
  return {
    status: 'not-applicable',
    evidence: [
      {
        subject: 'インフラ定義',
        detail: 'インフラ定義（CDK 合成結果）が提供されていないため、このルールは判定対象外です',
      },
    ],
  };
}

/** アーカイブ用バケットが見つからない場合の失敗評価。 */
function missingBucketEvaluation(purpose: string): RuleEvaluation {
  return {
    status: 'fail',
    evidence: [missingResourceEvidence('AWS::S3::Bucket', purpose)],
    remediation:
      'アーカイブを保存する S3 バケットを CDK で定義し、テンプレートを合成したうえで監査してください。',
  };
}

/**
 * バケットポリシーが TLS（aws:SecureTransport=false）を強制しているか。
 *
 * `PolicyDocument` がオブジェクトでなく文字列（`Fn::Join` の結果など）の場合は、
 * テキストに `aws:SecureTransport` と false が含まれるかで判定する（寛容な判定）。
 */
function enforcesTls(policy: ResourceLocation): boolean {
  const document = readProperty(propertiesOf(policy), 'PolicyDocument');
  if (typeof document === 'string') {
    return /aws:SecureTransport/i.test(document) && /false/i.test(document);
  }
  const statements = asArray(readProperty(asRecord(document), 'Statement'));
  for (const statement of statements ?? []) {
    const record = asRecord(statement);
    if (asString(readProperty(record, 'Effect')) !== 'Deny') {
      continue;
    }
    const condition = asRecord(readProperty(record, 'Condition'));
    const boolCondition = asRecord(readProperty(condition, 'Bool'));
    if (asBoolean(readProperty(boolCondition, 'aws:SecureTransport')) === false) {
      return true;
    }
  }
  return false;
}

/** CloudTrail のトレイルが S3 オブジェクトのデータイベントを記録しているか。 */
function recordsS3DataEvents(trail: ResourceLocation): boolean {
  const properties = propertiesOf(trail);

  // 旧来の EventSelectors 形式。
  for (const selector of asArray(readProperty(properties, 'EventSelectors')) ?? []) {
    const record = asRecord(selector);
    for (const dataResource of asArray(readProperty(record, 'DataResources')) ?? []) {
      if (asString(readProperty(asRecord(dataResource), 'Type')) === 'AWS::S3::Object') {
        return true;
      }
    }
  }

  // 新しい AdvancedEventSelectors 形式（resources.type = AWS::S3::Object）。
  for (const selector of asArray(readProperty(properties, 'AdvancedEventSelectors')) ?? []) {
    const record = asRecord(selector);
    for (const fieldSelector of asArray(readProperty(record, 'FieldSelectors')) ?? []) {
      const field = asRecord(fieldSelector);
      if (asString(readProperty(field, 'Field')) !== 'resources.type') {
        continue;
      }
      const equals = (asArray(readProperty(field, 'Equals')) ?? [])
        .map((value) => asString(value))
        .filter((value): value is string => value !== undefined);
      if (equals.includes('AWS::S3::Object')) {
        return true;
      }
    }
  }
  return false;
}

/**
 * INF-01: S3 Object Lock が有効（必須・真実性）。
 */
const INF_01: ComplianceRule = {
  id: 'INF-01',
  title: 'S3 Object Lock が有効',
  category: 'authenticity',
  severity: 'mandatory',
  description:
    'アーカイブ用 S3 バケットで Object Lock が有効になっており、保存した証憑が上書き・削除できないかを確認します。',
  reference: AWS_REFERENCES.objectLock,
  evaluate(context: RuleContext): RuleEvaluation {
    if (context.infra === undefined) {
      return notApplicableEvaluation();
    }
    const bucket = findArchiveBucket(context.infra);
    if (bucket === undefined) {
      return missingBucketEvaluation('S3 Object Lock の設定');
    }
    const enabled = isObjectLockEnabled(bucket);
    const evidence: EvidenceItem[] = [
      {
        subject: resourceSubject(bucket),
        detail: `Object Lock: ${enabledLabel(enabled)}`,
        value: enabled ? '有効' : '無効',
      },
    ];
    if (!enabled) {
      return {
        status: 'fail',
        evidence,
        remediation:
          'S3 バケットで `objectLockEnabled: true` を指定し、Object Lock を有効にしてください（既存バケットでは後から有効化できません）。',
      };
    }
    return { status: 'pass', evidence };
  },
};

/**
 * INF-02: 保持モードが COMPLIANCE で 7 年以上（必須・保存期間）。
 */
const INF_02: ComplianceRule = {
  id: 'INF-02',
  title: '保持モードが COMPLIANCE で 7 年以上',
  category: 'retention',
  severity: 'mandatory',
  description:
    'S3 Object Lock のデフォルト保持が COMPLIANCE モードかつ 2557 日（7 年相当）以上であり、期間中の削除ができないことを確認します。',
  reference: AWS_REFERENCES.objectLock,
  evaluate(context: RuleContext): RuleEvaluation {
    if (context.infra === undefined) {
      return notApplicableEvaluation();
    }
    const bucket = findArchiveBucket(context.infra);
    if (bucket === undefined) {
      return missingBucketEvaluation('Object Lock の保持設定');
    }
    const retention = readObjectLockRetention(bucket);
    if (retention === undefined) {
      return {
        status: 'fail',
        evidence: [
          {
            subject: resourceSubject(bucket),
            detail:
              'Object Lock のデフォルト保持設定（ObjectLockConfiguration.Rule.DefaultRetention）が見つかりません',
          },
        ],
        remediation:
          '`objectLockDefaultRetention: ObjectLockRetention.compliance(Duration.days(2557))` を設定してください。',
      };
    }

    const isCompliance = retention.mode === 'COMPLIANCE';
    const enoughDays = retention.days !== undefined && retention.days >= OBJECT_LOCK_RETENTION_DAYS;
    const evidence: EvidenceItem[] = [
      {
        subject: resourceSubject(bucket),
        detail: `保持モード: ${retention.mode ?? '未設定'}`,
        value: retention.mode ?? null,
      },
      {
        subject: resourceSubject(bucket),
        detail: `保持日数: ${
          retention.days === undefined ? '未設定' : `${retention.days} 日`
        }（要件: ${OBJECT_LOCK_RETENTION_DAYS} 日以上）`,
        value: retention.days ?? null,
      },
    ];

    if (!isCompliance || !enoughDays) {
      return {
        status: 'fail',
        evidence,
        remediation:
          '保持モードを COMPLIANCE にし、保持期間を 2557 日（7 年相当）以上に設定してください。GOVERNANCE モードでは特権ユーザーが削除できるため不十分です。',
      };
    }
    return { status: 'pass', evidence };
  },
};

/**
 * INF-03: バケットのバージョニングが有効（必須・真実性）。
 */
const INF_03: ComplianceRule = {
  id: 'INF-03',
  title: 'バケットのバージョニングが有効',
  category: 'authenticity',
  severity: 'mandatory',
  description:
    'S3 バケットのバージョニングが有効であり、過去バージョンが保持されることを確認します（Object Lock の前提でもあります）。',
  reference: AWS_REFERENCES.versioning,
  evaluate(context: RuleContext): RuleEvaluation {
    if (context.infra === undefined) {
      return notApplicableEvaluation();
    }
    const bucket = findArchiveBucket(context.infra);
    if (bucket === undefined) {
      return missingBucketEvaluation('バージョニングの設定');
    }
    const versioning = asRecord(readProperty(propertiesOf(bucket), 'VersioningConfiguration'));
    const status = asString(readProperty(versioning, 'Status'));
    const enabled = status === 'Enabled';
    const evidence: EvidenceItem[] = [
      {
        subject: resourceSubject(bucket),
        detail: `バージョニング: ${status ?? '未設定'}（要件: Enabled）`,
        value: status ?? null,
      },
    ];
    if (!enabled) {
      return {
        status: 'fail',
        evidence,
        remediation:
          'S3 バケットのバージョニングを有効にしてください（`versioned: true`）。Object Lock の利用にも必要です。',
      };
    }
    return { status: 'pass', evidence };
  },
};

/**
 * INF-04: パブリックアクセスが全面ブロック（必須・監査証跡）。
 */
const INF_04: ComplianceRule = {
  id: 'INF-04',
  title: 'パブリックアクセスが全面ブロック',
  category: 'auditability',
  severity: 'mandatory',
  description:
    'S3 バケットのパブリックアクセスブロックが 4 項目すべて有効で、証憑が公衆に公開されないことを確認します。',
  reference: AWS_REFERENCES.publicAccess,
  evaluate(context: RuleContext): RuleEvaluation {
    if (context.infra === undefined) {
      return notApplicableEvaluation();
    }
    const bucket = findArchiveBucket(context.infra);
    if (bucket === undefined) {
      return missingBucketEvaluation('パブリックアクセスのブロック設定');
    }
    const configuration = asRecord(
      readProperty(propertiesOf(bucket), 'PublicAccessBlockConfiguration'),
    );
    const evidence: EvidenceItem[] = [];
    let allBlocked = true;
    for (const key of PUBLIC_ACCESS_BLOCK_KEYS) {
      const value = asBoolean(readProperty(configuration, key));
      if (value !== true) {
        allBlocked = false;
      }
      evidence.push({
        subject: `${resourceSubject(bucket)}/${key}`,
        detail: `${key}: ${
          value === true ? 'true（ブロック有効）' : value === false ? 'false（ブロック無効）' : '未設定'
        }`,
        value: value === undefined ? null : String(value),
      });
    }

    if (!allBlocked) {
      return {
        status: 'fail',
        evidence,
        remediation:
          'パブリックアクセスブロックの 4 項目（BlockPublicAcls / BlockPublicPolicy / IgnorePublicAcls / RestrictPublicBuckets）をすべて有効にしてください。',
      };
    }
    return { status: 'pass', evidence };
  },
};

/**
 * INF-05: 保存データが暗号化されている（必須・KMS 推奨）。
 *
 * 暗号化自体は必須、カスタマーマネージド KMS キーの利用は推奨として扱う。
 */
const INF_05: ComplianceRule = {
  id: 'INF-05',
  title: '保存データが暗号化されている（KMS 推奨）',
  category: 'auditability',
  severity: 'mandatory',
  description:
    'S3 バケットのデフォルト暗号化（SSE）が設定され、保管データが暗号化されていることを確認します。KMS キー利用を推奨とします。',
  reference: AWS_REFERENCES.encryption,
  evaluate(context: RuleContext): RuleEvaluation {
    if (context.infra === undefined) {
      return notApplicableEvaluation();
    }
    const bucket = findArchiveBucket(context.infra);
    if (bucket === undefined) {
      return missingBucketEvaluation('暗号化の設定');
    }
    const encryption = asRecord(readProperty(propertiesOf(bucket), 'BucketEncryption'));
    const rules = asArray(readProperty(encryption, 'ServerSideEncryptionConfiguration'));
    if (rules === undefined || rules.length === 0) {
      return {
        status: 'fail',
        evidence: [
          {
            subject: resourceSubject(bucket),
            detail: 'BucketEncryption（ServerSideEncryptionConfiguration）が見つかりません',
          },
        ],
        remediation:
          'S3 バケットのデフォルト暗号化を有効にしてください。カスタマーマネージド KMS キー（SSE-KMS）の利用を推奨します。',
      };
    }

    const algorithms: string[] = [];
    const kmsKeyIds: string[] = [];
    for (const rule of rules) {
      const record = asRecord(rule);
      const byDefault = asRecord(readProperty(record, 'ServerSideEncryptionByDefault'));
      const algorithm = asString(readProperty(byDefault, 'SSEAlgorithm'));
      if (algorithm !== undefined) {
        algorithms.push(algorithm);
      }
      const keyId = asString(readProperty(byDefault, 'KMSMasterKeyID'));
      if (keyId !== undefined) {
        kmsKeyIds.push(keyId);
      }
    }

    const evidence: EvidenceItem[] = [
      {
        subject: resourceSubject(bucket),
        detail: `暗号化方式: ${algorithms.length === 0 ? '不明' : algorithms.join(', ')}`,
        value: algorithms.join(', '),
      },
    ];
    if (kmsKeyIds.length > 0) {
      evidence.push({
        subject: `${resourceSubject(bucket)}/KMSMasterKeyID`,
        detail: `KMS キー: ${kmsKeyIds.join(', ')}`,
      });
    }
    if (algorithms.length === 0) {
      return {
        status: 'fail',
        evidence,
        remediation: 'デフォルト暗号化に SSEAlgorithm（aws:kms または AES256）を設定してください。',
      };
    }

    const usesKms = algorithms.some((algorithm) => algorithm.toLowerCase() === 'aws:kms');
    if (!usesKms) {
      return {
        status: 'pass',
        evidence,
        remediation:
          '暗号化は有効ですが、監査・鍵管理の観点からカスタマーマネージド KMS キー（aws:kms）への移行を推奨します。',
      };
    }
    return { status: 'pass', evidence };
  },
};

/**
 * INF-06: TLS が強制されている（推奨・監査証跡）。
 */
const INF_06: ComplianceRule = {
  id: 'INF-06',
  title: 'TLS が強制されている',
  category: 'auditability',
  severity: 'recommended',
  description:
    'S3 バケットポリシーで、非 TLS（http）アクセスを Deny するステートメント（aws:SecureTransport=false）があるかを確認します。',
  reference: AWS_REFERENCES.tls,
  evaluate(context: RuleContext): RuleEvaluation {
    if (context.infra === undefined) {
      return notApplicableEvaluation();
    }
    const bucket = findArchiveBucket(context.infra);
    if (bucket === undefined) {
      return missingBucketEvaluation('TLS 強制ポリシー');
    }
    const policies = findResources(context.infra, 'AWS::S3::BucketPolicy');
    if (policies.length === 0) {
      return {
        status: 'fail',
        evidence: [
          missingResourceEvidence('AWS::S3::BucketPolicy', 'TLS（https）強制を確認できるバケットポリシー'),
        ],
        remediation:
          'S3 バケットポリシーで、`aws:SecureTransport` が false のアクセスを Deny してください（CDK の `enforceSSL: true`）。',
      };
    }

    const enforcing = policies.filter((policy) => enforcesTls(policy));
    if (enforcing.length === 0) {
      return {
        status: 'fail',
        evidence: policies.map((policy) => ({
          subject: resourceSubject(policy),
          detail:
            'TLS 強制（Effect: Deny / Condition.Bool["aws:SecureTransport"]: false）のステートメントが見つかりません',
        })),
        remediation:
          'S3 バケットポリシーに非 TLS アクセスを拒否するステートメントを追加してください（CDK の `enforceSSL: true`）。',
      };
    }

    return {
      status: 'pass',
      evidence: enforcing.map((policy) => ({
        subject: resourceSubject(policy),
        detail: 'TLS 強制（aws:SecureTransport=false を Deny）を確認しました',
      })),
    };
  },
};

/**
 * INF-07: CloudTrail がデータイベントを記録（必須・監査証跡）。
 */
const INF_07: ComplianceRule = {
  id: 'INF-07',
  title: 'CloudTrail がデータイベントを記録',
  category: 'auditability',
  severity: 'mandatory',
  description:
    'CloudTrail のトレイルが S3 オブジェクトのデータイベント（読み取り・書き込み）を記録するよう設定されているかを確認します。',
  reference: AWS_REFERENCES.cloudTrail,
  evaluate(context: RuleContext): RuleEvaluation {
    if (context.infra === undefined) {
      return notApplicableEvaluation();
    }
    const trails = findResources(context.infra, 'AWS::CloudTrail::Trail');
    if (trails.length === 0) {
      return {
        status: 'fail',
        evidence: [
          missingResourceEvidence('AWS::CloudTrail::Trail', 'S3 データイベントの記録状況'),
        ],
        remediation:
          'CloudTrail のトレイルを作成し、アーカイブ用 S3 バケットのオブジェクトレベルのデータイベントを記録してください。',
      };
    }

    const evidence: EvidenceItem[] = trails.map((trail) => {
      const records = recordsS3DataEvents(trail);
      return {
        subject: resourceSubject(trail),
        detail: `S3 オブジェクトのデータイベント:${records ? '記録あり' : '記録なし'}`,
        value: records ? '記録あり' : '記録なし',
      };
    });

    if (!trails.some((trail) => recordsS3DataEvents(trail))) {
      return {
        status: 'fail',
        evidence,
        remediation:
          'CloudTrail の EventSelectors / AdvancedEventSelectors に S3 オブジェクト（AWS::S3::Object）のデータイベントを追加してください。',
      };
    }
    return { status: 'pass', evidence };
  },
};

/**
 * INF-08: DynamoDB のポイントインタイムリカバリが有効（必須・監査証跡）。
 */
const INF_08: ComplianceRule = {
  id: 'INF-08',
  title: 'DynamoDB のポイントインタイムリカバリが有効',
  category: 'auditability',
  severity: 'mandatory',
  description:
    '索引・監査ログ・チェックポイントを保存する DynamoDB テーブルですべて PITR が有効になっているかを確認します。',
  reference: AWS_REFERENCES.dynamoDbPitr,
  evaluate(context: RuleContext): RuleEvaluation {
    if (context.infra === undefined) {
      return notApplicableEvaluation();
    }
    const tables = findResources(context.infra, 'AWS::DynamoDB::Table');
    if (tables.length === 0) {
      return {
        status: 'fail',
        evidence: [
          missingResourceEvidence('AWS::DynamoDB::Table', 'ポイントインタイムリカバリの設定'),
        ],
        remediation:
          '検索索引・監査ログ・チェックポイントを保存する DynamoDB テーブルを定義し、PITR を有効にしてください。',
      };
    }

    const evidence: EvidenceItem[] = [];
    let allEnabled = true;
    for (const table of tables) {
      const specification = asRecord(
        readProperty(propertiesOf(table), 'PointInTimeRecoverySpecification'),
      );
      const enabled =
        asBoolean(readProperty(specification, 'PointInTimeRecoveryEnabled')) === true;
      if (!enabled) {
        allEnabled = false;
      }
      evidence.push({
        subject: resourceSubject(table),
        detail: `ポイントインタイムリカバリ: ${enabledLabel(enabled)}`,
        value: enabled ? '有効' : '無効',
      });
    }

    if (!allEnabled) {
      return {
        status: 'fail',
        evidence,
        remediation:
          'すべての DynamoDB テーブルで `pointInTimeRecovery: true`（PointInTimeRecoveryEnabled: true）を設定してください。',
      };
    }
    return { status: 'pass', evidence };
  },
};

/**
 * INF-09: KMS キーローテーションが有効（推奨・監査証跡）。
 */
const INF_09: ComplianceRule = {
  id: 'INF-09',
  title: 'KMS キーローテーションが有効',
  category: 'auditability',
  severity: 'recommended',
  description:
    '保存データの暗号化に使う KMS キーで、自動ローテーションが有効になっているかを確認します。',
  reference: AWS_REFERENCES.kmsRotation,
  evaluate(context: RuleContext): RuleEvaluation {
    if (context.infra === undefined) {
      return notApplicableEvaluation();
    }
    const keys = findResources(context.infra, 'AWS::KMS::Key');
    if (keys.length === 0) {
      return {
        status: 'fail',
        evidence: [missingResourceEvidence('AWS::KMS::Key', 'キーローテーションの設定')],
        remediation:
          'カスタマーマネージド KMS キーを定義し、`enableKeyRotation: true` を設定してください。',
      };
    }

    const evidence: EvidenceItem[] = [];
    let allEnabled = true;
    for (const key of keys) {
      const enabled = asBoolean(readProperty(propertiesOf(key), 'EnableKeyRotation')) === true;
      if (!enabled) {
        allEnabled = false;
      }
      evidence.push({
        subject: resourceSubject(key),
        detail: `キーローテーション: ${enabledLabel(enabled)}`,
        value: enabled ? '有効' : '無効',
      });
    }

    if (!allEnabled) {
      return {
        status: 'fail',
        evidence,
        remediation: 'KMS キーで `enableKeyRotation: true` を設定してください。',
      };
    }
    return { status: 'pass', evidence };
  },
};

/**
 * INF-10: 整合性検証の失敗を検知するアラームがある（推奨・監査証跡）。
 */
const INF_10: ComplianceRule = {
  id: 'INF-10',
  title: '整合性検証の失敗を検知するアラームがある',
  category: 'auditability',
  severity: 'recommended',
  description:
    'ハッシュチェーン検証の失敗（ChainVerificationFailure）を検知して通知する CloudWatch アラームがあるかを確認します。',
  reference: AWS_REFERENCES.cloudWatchAlarm,
  evaluate(context: RuleContext): RuleEvaluation {
    if (context.infra === undefined) {
      return notApplicableEvaluation();
    }
    const alarms = findResources(context.infra, 'AWS::CloudWatch::Alarm');
    if (alarms.length === 0) {
      return {
        status: 'fail',
        evidence: [
          missingResourceEvidence('AWS::CloudWatch::Alarm', '整合性検証失敗の検知アラーム'),
        ],
        remediation:
          '`DenchoArchive/ChainVerificationFailure` メトリクスに対する CloudWatch アラームを作成し、通知先（SNS 等）を設定してください。',
      };
    }

    const evidence: EvidenceItem[] = [];
    let detected = false;
    for (const alarm of alarms) {
      const properties = propertiesOf(alarm);
      const metricName = asString(readProperty(properties, 'MetricName'));
      const namespace = asString(readProperty(properties, 'Namespace'));
      const isChainFailureAlarm =
        metricName !== undefined && metricName.includes('ChainVerificationFailure');
      if (isChainFailureAlarm) {
        detected = true;
      }
      evidence.push({
        subject: resourceSubject(alarm),
        detail: `メトリクス: ${namespace ?? '（不明）'}/${metricName ?? '（不明）'}${
          isChainFailureAlarm ? ' — 整合性検証の失敗を検知' : ''
        }`,
        value: metricName ?? null,
      });
    }

    if (!detected) {
      return {
        status: 'fail',
        evidence,
        remediation:
          '`DenchoArchive` 名前空間の `ChainVerificationFailure` メトリクスに対するアラームがありません。整合性検証の失敗を検知できるようにしてください。',
      };
    }
    return { status: 'pass', evidence };
  },
};

/**
 * インフラ（CloudFormation）系のビルトインルール。
 *
 * 並び順はレポートの表示順であり、`BUILTIN_RULES` の後半部分になる。
 */
export const INFRA_RULES: readonly ComplianceRule[] = [
  INF_01,
  INF_02,
  INF_03,
  INF_04,
  INF_05,
  INF_06,
  INF_07,
  INF_08,
  INF_09,
  INF_10,
];
