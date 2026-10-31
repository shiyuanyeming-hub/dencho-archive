/**
 * dencho-storage スタックのテスト。
 *
 * 電帳法の「真実性の確保」と「7 年保存」を担保する WORM 設定が、
 * 合成された CloudFormation テンプレートに実際に現れているかを検証する。
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
  numberAt,
  resourcesOfType,
  singleResourceOfType,
  stringAt,
  templateFor,
  type TestInfra,
} from './helpers.js';

describe('dencho-storage スタック', () => {
  let infra: TestInfra;

  beforeAll(() => {
    infra = createTestInfra();
  });

  afterAll(() => {
    infra.cleanup();
  });

  /** dencho-storage のテンプレート JSON。 */
  function storageDocument(): TemplateDocument {
    return documentOf(cfnTemplateOf(infra, 'dencho-storage'));
  }

  /** dencho-storage の S3 バケット定義（証憑アーカイブ用）。 */
  function archiveBucket(): unknown {
    return singleResourceOfType(storageDocument(), 'AWS::S3::Bucket').Properties;
  }

  it('WORM 保存に必要なリソース群だけを合成する', () => {
    const template = templateFor(infra, 'dencho-storage');
    template.resourceCountIs('AWS::S3::Bucket', 1);
    template.resourceCountIs('AWS::S3::BucketPolicy', 1);
    template.resourceCountIs('AWS::KMS::Key', 1);
    template.resourceCountIs('AWS::DynamoDB::Table', 3);
    // 証憑バケット + 削除時 TLS 強制ポリシー + KMS キー/エイリアス + 3 テーブル = 7。
    expect(Object.keys(storageDocument().Resources)).toHaveLength(7);
  });

  it('S3 Object Lock が有効になっている', () => {
    const template = templateFor(infra, 'dencho-storage');
    template.hasResourceProperties('AWS::S3::Bucket', {
      ObjectLockEnabled: true,
      ObjectLockConfiguration: { ObjectLockEnabled: 'Enabled' },
    });
    expect(booleanAt(archiveBucket(), 'ObjectLockEnabled')).toBe(true);
    expect(stringAt(archiveBucket(), 'ObjectLockConfiguration', 'ObjectLockEnabled')).toBe('Enabled');
  });

  it('Object Lock の既定保持は COMPLIANCE モード 2557 日（7 年）', () => {
    const template = templateFor(infra, 'dencho-storage');
    template.hasResourceProperties('AWS::S3::Bucket', {
      ObjectLockConfiguration: {
        Rule: { DefaultRetention: { Mode: 'COMPLIANCE', Days: 2557 } },
      },
    });
    expect(stringAt(archiveBucket(), 'ObjectLockConfiguration', 'Rule', 'DefaultRetention', 'Mode')).toBe('COMPLIANCE');
    expect(numberAt(archiveBucket(), 'ObjectLockConfiguration', 'Rule', 'DefaultRetention', 'Days')).toBe(2557);
  });

  it('バケットのバージョニングが有効（Object Lock の前提）', () => {
    const template = templateFor(infra, 'dencho-storage');
    template.hasResourceProperties('AWS::S3::Bucket', { VersioningConfiguration: { Status: 'Enabled' } });
  });

  it('パブリックアクセスが 4 項目すべてブロックされている', () => {
    const template = templateFor(infra, 'dencho-storage');
    template.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
  });

  it('保存データはカスタマー管理の KMS キーで暗号化される（SSE-S3 ではない）', () => {
    const document = storageDocument();
    const bucket = singleResourceOfType(document, 'AWS::S3::Bucket').Properties;
    expect(stringAt(bucket, 'BucketEncryption', 'ServerSideEncryptionConfiguration', '0', 'ServerSideEncryptionByDefault', 'SSEAlgorithm')).toBe(
      'aws:kms',
    );
    expect(booleanAt(bucket, 'BucketEncryption', 'ServerSideEncryptionConfiguration', '0', 'BucketKeyEnabled')).toBe(true);

    const keyLogicalId = resourcesOfType(document, 'AWS::KMS::Key')[0]?.logicalId;
    expect(keyLogicalId).toBeDefined();
    // KMSMasterKeyID はカスタマー管理キーへの参照（GetAtt）であること。
    expect(stringAt(bucket, 'BucketEncryption', 'ServerSideEncryptionConfiguration', '0', 'ServerSideEncryptionByDefault', 'KMSMasterKeyID', 'Fn::GetAtt', '0')).toBe(
      keyLogicalId,
    );
  });

  it('KMS キーのローテーションが有効で、スタック削除後も保持される', () => {
    const template = templateFor(infra, 'dencho-storage');
    template.hasResource('AWS::KMS::Key', { DeletionPolicy: 'Retain', UpdateReplacePolicy: 'Retain' });
    const key = singleResourceOfType(storageDocument(), 'AWS::KMS::Key');
    expect(booleanAt(key.Properties, 'EnableKeyRotation')).toBe(true);
    expect(key.DeletionPolicy).toBe('Retain');
  });

  it('バケット・テーブル・キーはどれも削除時に保持される（RETAIN）', () => {
    const document = storageDocument();
    for (const type of ['AWS::S3::Bucket', 'AWS::KMS::Key', 'AWS::DynamoDB::Table']) {
      for (const { logicalId, resource } of resourcesOfType(document, type)) {
        expect(resource.DeletionPolicy, `${logicalId} は RETAIN であること`).toBe('Retain');
        expect(resource.UpdateReplacePolicy, `${logicalId} は更新時も保持されること`).toBe('Retain');
      }
    }
  });

  it('autoDeleteObjects を使わない（WORM と矛盾するため）', () => {
    const document = storageDocument();
    const customResources = Object.values(document.Resources).filter((resource) => resource.Type.startsWith('Custom::'));
    expect(customResources).toHaveLength(0);
    expect(JSON.stringify(document)).not.toContain('AutoDeleteObjects');
    // 保存層に Lambda は置かない。
    expect(resourcesOfType(document, 'AWS::Lambda::Function')).toHaveLength(0);
  });

  it('3 つの DynamoDB テーブルは PITR・暗号化・削除保護・オンデマンド課金', () => {
    const document = storageDocument();
    const tables = resourcesOfType(document, 'AWS::DynamoDB::Table');
    expect(tables).toHaveLength(3);

    const expectedNames = ['dencho-voucher-index', 'dencho-audit-log', 'dencho-chain-checkpoints'];
    expect(tables.map(({ resource }) => stringAt(resource.Properties, 'TableName')).sort()).toEqual([...expectedNames].sort());

    for (const { logicalId, resource } of tables) {
      const properties = resource.Properties;
      expect(booleanAt(properties, 'PointInTimeRecoverySpecification', 'PointInTimeRecoveryEnabled'), `${logicalId} の PITR`).toBe(true);
      expect(booleanAt(properties, 'SSESpecification', 'SSEEnabled'), `${logicalId} の暗号化`).toBe(true);
      expect(booleanAt(properties, 'DeletionProtectionEnabled'), `${logicalId} の削除保護`).toBe(true);
      expect(stringAt(properties, 'BillingMode'), `${logicalId} の課金モード`).toBe('PAY_PER_REQUEST');
      // 索引は pk/sk の複合キーで引く（search 要件の 3 項目を 1 テーブルで表現する）。
      expect(stringAt(properties, 'KeySchema', '0', 'AttributeName')).toBe('pk');
      expect(stringAt(properties, 'KeySchema', '0', 'KeyType')).toBe('HASH');
      expect(stringAt(properties, 'KeySchema', '1', 'AttributeName')).toBe('sk');
      expect(stringAt(properties, 'KeySchema', '1', 'KeyType')).toBe('RANGE');
    }
  });

  it('監査ログは追記専用を検証できるよう DynamoDB ストリームを持つ', () => {
    const document = storageDocument();
    const tables = resourcesOfType(document, 'AWS::DynamoDB::Table');
    const auditLog = tables.find(({ resource }) => stringAt(resource.Properties, 'TableName') === 'dencho-audit-log');
    expect(auditLog).toBeDefined();
    expect(stringAt(auditLog?.resource.Properties, 'StreamSpecification', 'StreamViewType')).toBe('NEW_AND_OLD_IMAGES');

    // 他のテーブルには不要なストリームを付けない（コスト最小化）。
    const others = tables.filter(({ resource }) => stringAt(resource.Properties, 'TableName') !== 'dencho-audit-log');
    for (const { resource } of others) {
      expect(resource.Properties?.['StreamSpecification']).toBeUndefined();
    }
  });

  it('バケットポリシーで TLS（HTTPS）を強制している', () => {
    const document = storageDocument();
    const policy = singleResourceOfType(document, 'AWS::S3::BucketPolicy');
    const statements = asArray(at(policy.Properties, 'PolicyDocument', 'Statement'));
    const tlsDeny = statements
      .map((statement) => ({ statement, effect: stringAt(statement, 'Effect') }))
      .find((entry) => entry.effect === 'Deny' && at(entry.statement, 'Condition', 'Bool', 'aws:SecureTransport') === 'false');
    expect(tlsDeny).toBeDefined();
    expect(tlsDeny?.statement).toBeDefined();
    expect(stringAt(tlsDeny?.statement, 'Action')).toBe('s3:*');
  });
});
