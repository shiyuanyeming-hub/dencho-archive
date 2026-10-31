/**
 * S3 を保存先にした BlobStore。
 *
 * 証憑データ本体とメタデータを S3 に置く。本番のバケットは
 * Object Lock（COMPLIANCE / 7 年）で作成されており、上書き・削除が拒否される。
 * ここでは追加の防御として、オブジェクト単位でも保持期間を指定できるように
 * している（バケット既定値との二重化）。
 *
 * キーは内容アドレス（`objects/ab/cd/<sha256>`）。同じ内容は同じキーになるため、
 * 保存の再試行が冪等になる。
 */
import {
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import { IntegrityError, NotFoundError, ValidationError } from '../../core/errors.js';
import type { BlobStore, Clock } from '../../core/types.js';

/** S3 アダプタの設定。 */
export interface S3BlobStoreOptions {
  readonly bucket: string;
  /** キーの前置き（例: `archive/`）。 */
  readonly prefix?: string;
  readonly client: S3Client;
  /** オブジェクト単位で付ける Object Lock の保持日数。 */
  readonly retentionDays?: number;
  readonly clock?: Clock;
}

/** S3 の Object Lock モード。 */
export type ObjectLockMode = 'COMPLIANCE' | 'GOVERNANCE';

/** S3 の Object Lock 設定。 */
export const DEFAULT_OBJECT_LOCK_MODE: ObjectLockMode = 'COMPLIANCE';

/** S3 実装の BlobStore。 */
export class S3BlobStore implements BlobStore {
  private readonly bucket: string;
  private readonly prefix: string;
  private readonly client: S3Client;
  private readonly retentionDays: number | undefined;
  private readonly clock: Clock;

  constructor(options: S3BlobStoreOptions) {
    this.bucket = options.bucket;
    this.prefix = options.prefix === undefined ? '' : `${options.prefix.replace(/\/+$/, '')}/`;
    this.client = options.client;
    this.retentionDays = options.retentionDays;
    this.clock = options.clock ?? { now: () => new Date() };
  }

  async put(key: string, data: Uint8Array): Promise<void> {
    const fullKey = this.fullKey(key);
    const retainUntil = this.retentionDays === undefined ? undefined : this.retainUntil();
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: fullKey,
          Body: data,
          ContentLength: data.byteLength,
          ContentType: 'application/octet-stream',
          ...(retainUntil === undefined
            ? {}
            : {
                ObjectLockMode: DEFAULT_OBJECT_LOCK_MODE,
                ObjectLockRetainUntilDate: retainUntil,
              }),
        }),
      );
    } catch (error) {
      throw new IntegrityError('証憑データを S3 へ保存できませんでした', {
        key: fullKey,
        cause: describe(error),
      });
    }
  }

  async get(key: string): Promise<Uint8Array> {
    const fullKey = this.fullKey(key);
    try {
      const response = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: fullKey }));
      const body = response.Body;
      if (body === undefined) {
        throw new NotFoundError(`オブジェクトの本文が空です: ${fullKey}`, { key: fullKey });
      }
      return await body.transformToByteArray();
    } catch (error) {
      if (isNotFound(error)) {
        throw new NotFoundError(`オブジェクトが見つかりません: ${fullKey}`, { key: fullKey });
      }
      throw error;
    }
  }

  async has(key: string): Promise<boolean> {
    const fullKey = this.fullKey(key);
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: fullKey }));
      return true;
    } catch (error) {
      if (isNotFound(error)) {
        return false;
      }
      throw error;
    }
  }

  async list(prefix?: string): Promise<readonly string[]> {
    const fullPrefix = `${this.prefix}${prefix ?? ''}`;
    const keys: string[] = [];
    let continuationToken: string | undefined;
    do {
      const response = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: fullPrefix,
          ...(continuationToken === undefined ? {} : { ContinuationToken: continuationToken }),
        }),
      );
      for (const object of response.Contents ?? []) {
        const key = object.Key;
        if (key === undefined) {
          continue;
        }
        keys.push(key.startsWith(this.prefix) ? key.slice(this.prefix.length) : key);
      }
      continuationToken = response.IsTruncated === true ? response.NextContinuationToken : undefined;
    } while (continuationToken !== undefined);
    return keys.sort();
  }

  /** キーを検証し、バケット内のフルキーへ変換する。 */
  private fullKey(key: string): string {
    validateKey(key);
    return `${this.prefix}${key}`;
  }

  /** 保持期限を計算する。 */
  private retainUntil(): Date {
    const days = this.retentionDays ?? 0;
    return new Date(this.clock.now().getTime() + days * 24 * 60 * 60 * 1000);
  }
}

/** パス移動を試みるキーを拒否する（ディレクトリ外への書き込み防止）。 */
export function validateKey(key: string): void {
  if (key.length === 0) {
    throw new ValidationError('保存キーが空です');
  }
  if (key.startsWith('/') || key.includes('\\')) {
    throw new ValidationError(`保存キーの形式が不正です: ${key}`);
  }
  for (const segment of key.split('/')) {
    if (segment === '..' || segment === '.' || segment === '') {
      throw new ValidationError(`保存キーに不正なセグメントがあります: ${key}`);
    }
  }
}

/** NotFound 系の例外か。 */
function isNotFound(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const name = (error as { name?: string }).name;
  const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
  return name === 'NoSuchKey' || name === 'NotFound' || name === 'NoSuchBucket' || status === 404;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
