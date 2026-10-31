/**
 * AWS アダプタの単体テスト。
 *
 * 実際の AWS へは接続しない（資格情報が無い CI でも実行できるようにするため）。
 * SDK クライアントの `send` を差し替え、組み立てられるリクエストと
 * エラー変換を検証する。実サービスに対する統合テストは
 * `docs/INFRA.ja.md` の手順で別途行う想定。
 */
import { describe, expect, it } from 'vitest';
import type { S3Client } from '@aws-sdk/client-s3';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { S3BlobStore } from '../../src/adapters/aws/s3-blob-store.js';
import { DynamoDbManifestStore } from '../../src/adapters/aws/dynamodb-manifest-store.js';

interface RecordedCommand {
  readonly name: string;
  readonly input: Record<string, unknown>;
}

/** S3 の代わりにメモリへ保存する偽クライアント。 */
class FakeS3 {
  readonly calls: RecordedCommand[] = [];
  readonly objects = new Map<string, Uint8Array>();

  async send(command: { constructor: { name: string }; input: Record<string, unknown> }): Promise<unknown> {
    const name = command.constructor.name;
    const input = command.input;
    this.calls.push({ name, input });
    switch (name) {
      case 'PutObjectCommand': {
        this.objects.set(String(input['Key']), input['Body'] as Uint8Array);
        return {};
      }
      case 'GetObjectCommand': {
        const bytes = this.objects.get(String(input['Key']));
        if (bytes === undefined) {
          throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey', $metadata: { httpStatusCode: 404 } });
        }
        return { Body: { transformToByteArray: async () => bytes } };
      }
      case 'HeadObjectCommand': {
        if (!this.objects.has(String(input['Key']))) {
          throw Object.assign(new Error('NotFound'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } });
        }
        return {};
      }
      case 'ListObjectsV2Command': {
        const prefix = String(input['Prefix'] ?? '');
        return {
          Contents: [...this.objects.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ Key: key })),
          IsTruncated: false,
        };
      }
      default:
        return {};
    }
  }
}

/** DynamoDB の代わりにメモリへ保存する偽クライアント。 */
class FakeDocumentClient {
  readonly tables = new Map<string, Map<string, Record<string, unknown>>>();
  sql: string[] = [];
  failNextTransaction = false;

  private table(name: string): Map<string, Record<string, unknown>> {
    const existing = this.tables.get(name);
    if (existing !== undefined) {
      return existing;
    }
    const created = new Map<string, Record<string, unknown>>();
    this.tables.set(name, created);
    return created;
  }

  async send(command: { constructor: { name: string }; input: Record<string, unknown> }): Promise<unknown> {
    const name = command.constructor.name;
    const input = command.input;
    this.sql.push(name);

    // トランザクション/バッチはアイテムごとに TableName を持つため、
    // テーブル未指定のコマンドは各リクエストから解決する。
    const tableFor = (tableName: unknown): Map<string, Record<string, unknown>> => this.table(String(tableName));
    const table = name === 'TransactWriteCommand' || name === 'BatchWriteCommand'
      ? undefined
      : tableFor(input['TableName']);

    switch (name) {
      case 'GetCommand': {
        const key = input['Key'] as { pk: string; sk: string };
        return { Item: table?.get(`${key.pk}|${key.sk}`) };
      }
      case 'PutCommand': {
        const item = input['Item'] as Record<string, unknown>;
        table?.set(`${String(item['pk'])}|${String(item['sk'])}`, item);
        return {};
      }
      case 'QueryCommand': {
        const values = input['ExpressionAttributeValues'] as Record<string, string>;
        const pk = values[':pk'];
        const prefix = values[':prefix'];
        const items = [...(table?.values() ?? [])]
          .filter((item) => item['pk'] === pk)
          .filter((item) => (prefix === undefined ? true : String(item['sk']).startsWith(prefix)))
          .sort((a, b) => String(a['sk']).localeCompare(String(b['sk'])));
        return { Items: items };
      }
      case 'ScanCommand':
        return { Items: [...(table?.values() ?? [])] };
      case 'BatchWriteCommand': {
        const requestItems = input['RequestItems'] as Record<string, unknown[]>;
        const tableName = Object.keys(requestItems)[0] ?? '';
        const batchTable = tableFor(tableName);
        const requests = Object.values(requestItems)[0] ?? [];
        for (const request of requests as { PutRequest?: { Item: Record<string, unknown> }; DeleteRequest?: { Key: { pk: string; sk: string } } }[]) {
          if (request.PutRequest !== undefined) {
            const item = request.PutRequest.Item;
            batchTable.set(`${String(item['pk'])}|${String(item['sk'])}`, item);
          }
          if (request.DeleteRequest !== undefined) {
            batchTable.delete(`${request.DeleteRequest.Key.pk}|${request.DeleteRequest.Key.sk}`);
          }
        }
        return {};
      }
      case 'UpdateCommand': {
        const key = input['Key'] as { pk: string; sk: string };
        const existing = table?.get(`${key.pk}|${key.sk}`) ?? { pk: key.pk, sk: key.sk };
        const values = input['ExpressionAttributeValues'] as Record<string, unknown>;
        table?.set(`${key.pk}|${key.sk}`, { ...existing, checkpoints: values[':checkpoints'] });
        return {};
      }
      case 'TransactWriteCommand': {
        if (this.failNextTransaction) {
          this.failNextTransaction = false;
          throw Object.assign(new Error('Transaction cancelled'), {
            name: 'TransactionCanceledException',
            CancellationReasons: [{ Code: 'ConditionalCheckFailed' }],
          });
        }
        const items = input['TransactItems'] as {
          ConditionCheck?: { TableName: string; Key: { pk: string; sk: string } };
          Put?: { TableName: string; Item: Record<string, unknown> };
        }[];
        for (const item of items) {
          if (item.Put !== undefined) {
            const record = item.Put.Item;
            tableFor(item.Put.TableName).set(`${String(record['pk'])}|${String(record['sk'])}`, record);
          }
        }
        return {};
      }
      default:
        return {};
    }
  }
}

const CLOCK = { now: () => new Date('2026-10-01T09:00:00+09:00') };

function makeStore(fake: FakeS3, retentionDays?: number): S3BlobStore {
  return new S3BlobStore({
    bucket: 'archive-bucket',
    prefix: 'archive',
    client: fake as unknown as S3Client,
    clock: CLOCK,
    ...(retentionDays === undefined ? {} : { retentionDays }),
  });
}

describe('S3BlobStore', () => {
  it('内容を保存して取り出せる', async () => {
    const fake = new FakeS3();
    const store = makeStore(fake);
    const data = new TextEncoder().encode('証憑データ');
    await store.put('objects/aa/bb/hash', data);
    await expect(store.get('objects/aa/bb/hash')).resolves.toEqual(data);
  });

  it('バケットの前置きをキーへ付ける', async () => {
    const fake = new FakeS3();
    const store = makeStore(fake);
    await store.put('objects/x', new Uint8Array([1]));
    expect(fake.calls[0]?.input['Key']).toBe('archive/objects/x');
  });

  it('保持期間を指定すると COMPLIANCE モードで Object Lock を付ける', async () => {
    const fake = new FakeS3();
    const store = makeStore(fake, 2557);
    await store.put('objects/x', new Uint8Array([1]));
    const input = fake.calls[0]?.input;
    expect(input?.['ObjectLockMode']).toBe('COMPLIANCE');
    const retainUntil = input?.['ObjectLockRetainUntilDate'] as Date;
    const days = Math.round((retainUntil.getTime() - CLOCK.now().getTime()) / 86_400_000);
    expect(days).toBe(2557);
  });

  it('存在しないオブジェクトは NotFoundError', async () => {
    const store = makeStore(new FakeS3());
    await expect(store.get('objects/none')).rejects.toThrow(/見つかりません/);
  });

  it('has は存在を返す', async () => {
    const fake = new FakeS3();
    const store = makeStore(fake);
    expect(await store.has('objects/x')).toBe(false);
    await store.put('objects/x', new Uint8Array([1]));
    expect(await store.has('objects/x')).toBe(true);
  });

  it('list は前置きを外して整列して返す', async () => {
    const fake = new FakeS3();
    const store = makeStore(fake);
    await store.put('metadata/b', new Uint8Array([2]));
    await store.put('metadata/a', new Uint8Array([1]));
    expect(await store.list('metadata/')).toEqual(['metadata/a', 'metadata/b']);
  });

  it('パス移動を狙うキーを拒否する', async () => {
    const store = makeStore(new FakeS3());
    await expect(store.put('../escape', new Uint8Array([1]))).rejects.toThrow(/不正/);
    await expect(store.put('/absolute', new Uint8Array([1]))).rejects.toThrow(/不正/);
    await expect(store.put('a/../../b', new Uint8Array([1]))).rejects.toThrow(/不正/);
  });
});

describe('DynamoDbManifestStore', () => {
  function makeStore(fake: FakeDocumentClient, archiveId = 'test-archive'): DynamoDbManifestStore {
    return new DynamoDbManifestStore({
      tableName: 'ledger',
      archiveId,
      client: fake as unknown as DynamoDBDocumentClient,
    });
  }

  const entry = (sequence: number, previousEntryHash: string, hash: string) => ({
    sequence,
    voucherId: `V-${sequence}`,
    objectKey: `objects/${hash}`,
    contentSha256: hash,
    metadataSha256: hash,
    timestampSha256: hash,
    recordedAt: '2026-10-01T09:00:00+09:00',
    previousEntryHash,
    entryHash: hash,
  });

  it('初期化して空の台帳を読める', async () => {
    const fake = new FakeDocumentClient();
    const store = makeStore(fake);
    await store.initialize({ createdAt: '2026-10-01T09:00:00+09:00', retentionYears: 7, worm: true });
    const manifest = await store.read();
    expect(manifest.entries).toEqual([]);
    expect(manifest.retentionYears).toBe(7);
    expect(manifest.worm).toBe(true);
  });

  it('追記すると台帳と先頭が更新される', async () => {
    const fake = new FakeDocumentClient();
    const store = makeStore(fake);
    await store.initialize({ createdAt: '2026-10-01T09:00:00+09:00', retentionYears: 7, worm: true });
    await store.append(entry(1, '0'.repeat(64), 'a'.repeat(64)), { sequence: 0, entryHash: null });
    const manifest = await store.read();
    expect(manifest.entries.length).toBe(1);
    expect(manifest.entries[0]?.entryHash).toBe('a'.repeat(64));
  });

  it('先頭が変わっていたら ChainConflictError（楽観的排他制御）', async () => {
    const fake = new FakeDocumentClient();
    const store = makeStore(fake);
    await store.initialize({ createdAt: '2026-10-01T09:00:00+09:00', retentionYears: 7, worm: true });
    await store.append(entry(1, '0'.repeat(64), 'a'.repeat(64)), { sequence: 0, entryHash: null });

    fake.failNextTransaction = true;
    await expect(
      store.append(entry(2, 'a'.repeat(64), 'b'.repeat(64)), { sequence: 1, entryHash: 'a'.repeat(64) }),
    ).rejects.toThrow(/台帳の先頭が変わりました/);
  });

  it('追記位置の不整合は検証で拒否する', async () => {
    const fake = new FakeDocumentClient();
    const store = makeStore(fake);
    await store.initialize({ createdAt: '2026-10-01T09:00:00+09:00', retentionYears: 7, worm: true });
    await expect(
      store.append(entry(5, '0'.repeat(64), 'a'.repeat(64)), { sequence: 0, entryHash: null }),
    ).rejects.toThrow(/整合しません/);
  });

  it('チェックポイントを保存できる', async () => {
    const fake = new FakeDocumentClient();
    const store = makeStore(fake);
    await store.initialize({ createdAt: '2026-10-01T09:00:00+09:00', retentionYears: 7, worm: true });
    await store.updateCheckpoints([{ sequence: 1, entryHash: 'a'.repeat(64), recordedAt: '2026-10-01T09:00:00+09:00' }]);
    const manifest = await store.read();
    expect(manifest.checkpoints.length).toBe(1);
    expect(manifest.checkpoints[0]?.sequence).toBe(1);
  });

  it('未初期化のアーカイブは NotFoundError', async () => {
    const store = makeStore(new FakeDocumentClient());
    await expect(store.read()).rejects.toThrow(/見つかりません/);
  });
});
