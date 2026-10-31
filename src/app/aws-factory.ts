/**
 * AWS 上でアーカイブを組み立てるファクトリ。
 *
 * Lambda のハンドラはこの関数だけを呼ぶ。ローカル実装（`factory.ts`）と
 * 同じ `Archive` インタフェースを返すため、アプリケーションコードは
 * 環境を意識しない。
 *
 * 必要な環境変数:
 *   DENCHO_BUCKET           証憑データ用 S3 バケット（Object Lock 有効）
 *   DENCHO_LEDGER_TABLE     台帳用 DynamoDB テーブル
 *   DENCHO_INDEX_TABLE      検索索引用 DynamoDB テーブル
 *   DENCHO_ARCHIVE_ID       アーカイブ識別子
 *   DENCHO_TSA_SECRET       タイムスタンプ署名鍵（Secrets Manager から注入する想定）
 *   DENCHO_RETENTION_DAYS   S3 オブジェクト単位の保持日数（既定 2557 = 7 年）
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';
import { ValidationError } from '../core/errors.js';
import { SystemClock } from '../core/time.js';
import { LocalHmacTimestampAuthority } from '../core/timestamp.js';
import { S3BlobStore } from '../adapters/aws/s3-blob-store.js';
import { DynamoDbIndexStore } from '../adapters/aws/dynamodb-index-store.js';
import { DynamoDbManifestStore } from '../adapters/aws/dynamodb-manifest-store.js';
import type { Archive, ArchiveConfig, Clock } from '../core/types.js';
import { createArchive } from './archive.js';

/** 7 年の日数（閏年を含む換算: 365 × 7 + 2）。 */
export const SEVEN_YEARS_IN_DAYS = 2557;

/** AWS アーカイブの設定。 */
export interface AwsArchiveOptions {
  readonly bucket: string;
  readonly ledgerTable: string;
  readonly indexTable: string;
  readonly archiveId: string;
  readonly region?: string;
  readonly retentionDays?: number;
  readonly timestampSecret: string;
  readonly timestampMaxDelayDays?: number;
  readonly clock?: Clock;
}

/** AWS 上で動くアーカイブを作る。 */
export function createAwsArchive(options: AwsArchiveOptions): Archive {
  const region = options.region ?? process.env['AWS_REGION'] ?? 'ap-northeast-1';
  const clock = options.clock ?? new SystemClock();
  const s3 = new S3Client({ region });
  const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient({ region }), {
    marshallOptions: { removeUndefinedValues: true },
  });

  const config: ArchiveConfig = {
    archiveId: options.archiveId,
    retentionYears: 7,
    timestampMaxDelayDays: options.timestampMaxDelayDays ?? 62,
    worm: true,
    requireTimestamp: true,
  };

  return createArchive({
    config,
    blobs: new S3BlobStore({
      bucket: options.bucket,
      prefix: 'archive',
      client: s3,
      retentionDays: options.retentionDays ?? SEVEN_YEARS_IN_DAYS,
      clock,
    }),
    manifest: new DynamoDbManifestStore({
      tableName: options.ledgerTable,
      archiveId: options.archiveId,
      client: documentClient,
    }),
    index: new DynamoDbIndexStore({ tableName: options.indexTable, client: documentClient }),
    clock,
    tsa: new LocalHmacTimestampAuthority({ secret: options.timestampSecret, clock }),
  });
}

/** 環境変数から AWS アーカイブを作る（Lambda のハンドラ用）。 */
export function awsArchiveFromEnv(env: NodeJS.ProcessEnv = process.env): Archive {
  const required = (name: string): string => {
    const value = env[name];
    if (value === undefined || value.trim() === '') {
      throw new ValidationError(`環境変数 ${name} が設定されていません`);
    }
    return value;
  };

  const retention = env['DENCHO_RETENTION_DAYS'];
  return createAwsArchive({
    bucket: required('DENCHO_BUCKET'),
    ledgerTable: required('DENCHO_LEDGER_TABLE'),
    indexTable: required('DENCHO_INDEX_TABLE'),
    archiveId: required('DENCHO_ARCHIVE_ID'),
    ...(env['AWS_REGION'] === undefined ? {} : { region: env['AWS_REGION'] }),
    ...(retention === undefined ? {} : { retentionDays: Number.parseInt(retention, 10) }),
    timestampSecret: required('DENCHO_TSA_SECRET'),
    ...(env['DENCHO_TIMESTAMP_MAX_DELAY_DAYS'] === undefined
      ? {}
      : { timestampMaxDelayDays: Number.parseInt(env['DENCHO_TIMESTAMP_MAX_DELAY_DAYS'], 10) }),
  });
}

/** ハンドラ間でアーカイブを共有する（Lambda の実行環境再利用）。 */
let cached: Archive | undefined;

/** キャッシュしたアーカイブを返す。 */
export function getAwsArchive(): Archive {
  cached ??= awsArchiveFromEnv();
  return cached;
}

/** テスト用にキャッシュを破棄する。 */
export function resetAwsArchiveCache(): void {
  cached = undefined;
}
