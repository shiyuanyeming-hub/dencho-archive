/**
 * DynamoDB を台帳（マニフェスト）の保存先にした ManifestStore。
 *
 * 設計上の要点:
 * - **証憑データは S3 の WORM バケットへ**置くが、台帳は追記が必要なので
 *   Object Lock の効いたバケットには置けない（上書きが拒否されるため）。
 *   台帳は DynamoDB に置き、ポイントインタイムリカバリと CloudTrail で保護する。
 * - **追記はトランザクションで原子的に行う。** 先頭（HEAD）の条件を
 *   ConditionCheck で検証し、台帳エントリと HEAD を同時に更新する。
 *   これにより「同じ位置に 2 件書かれる」「チェーンが分岐する」競合を防ぐ。
 * - 競合した場合は `ChainConflictError` を投げ、呼び出し側が読み直して再試行する。
 */
import {
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { ChainConflictError, NotFoundError, ValidationError } from '../../core/errors.js';
import type { ArchiveManifest, ChainCheckpoint, LedgerEntry, ManifestStore, Sha256Hex } from '../../core/types.js';

/** DynamoDB 台帳アダプタの設定。 */
export interface DynamoDbManifestStoreOptions {
  readonly tableName: string;
  readonly archiveId: string;
  readonly client: DynamoDBDocumentClient;
}

const META_SORT_KEY = '#META';
const HEAD_SORT_KEY = '#HEAD';
const ENTRY_PREFIX = 'E#';
const ENTRY_SORT_KEY_WIDTH = 12;

/** 台帳アダプタ。 */
export class DynamoDbManifestStore implements ManifestStore {
  private readonly tableName: string;
  private readonly archiveId: string;
  private readonly client: DynamoDBDocumentClient;
  private readonly partitionKey: string;

  constructor(options: DynamoDbManifestStoreOptions) {
    this.tableName = options.tableName;
    this.archiveId = options.archiveId;
    this.client = options.client;
    this.partitionKey = `ARCHIVE#${options.archiveId}`;
  }

  async read(): Promise<ArchiveManifest> {
    const meta = await this.client.send(
      new GetCommand({ TableName: this.tableName, Key: { pk: this.partitionKey, sk: META_SORT_KEY } }),
    );
    if (meta.Item === undefined) {
      throw new NotFoundError(`アーカイブのメタ情報が見つかりません: ${this.archiveId}`, {
        archiveId: this.archiveId,
        table: this.tableName,
      });
    }

    const entries = await this.readEntries();
    const metaItem = meta.Item as Record<string, unknown>;
    return {
      schemaVersion: 1,
      archiveId: this.archiveId,
      createdAt: String(metaItem['createdAt']),
      retentionYears: Number(metaItem['retentionYears']),
      worm: Boolean(metaItem['worm']),
      entries,
      checkpoints: parseCheckpoints(metaItem['checkpoints']),
    };
  }

  async append(
    entry: LedgerEntry,
    expectHead: { readonly sequence: number; readonly entryHash: Sha256Hex | null },
  ): Promise<void> {
    if (entry.sequence !== expectHead.sequence + 1) {
      throw new ValidationError('追記するエントリの位置が先頭と整合しません', {
        expectedSequence: expectHead.sequence + 1,
        actualSequence: entry.sequence,
      });
    }

    const headCondition =
      expectHead.sequence === 0
        ? { ConditionExpression: 'attribute_not_exists(pk)' }
        : {
            ConditionExpression: '#sequence = :expectedSequence AND #entryHash = :expectedHash',
            ExpressionAttributeNames: { '#sequence': 'sequence', '#entryHash': 'entryHash' },
            ExpressionAttributeValues: {
              ':expectedSequence': expectHead.sequence,
              ':expectedHash': expectHead.entryHash,
            },
          };

    try {
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              ConditionCheck: {
                TableName: this.tableName,
                Key: { pk: this.partitionKey, sk: HEAD_SORT_KEY },
                ...headCondition,
              },
            },
            {
              Put: {
                TableName: this.tableName,
                Item: { pk: this.partitionKey, sk: entrySortKey(entry.sequence), ...entry },
              },
            },
            {
              Put: {
                TableName: this.tableName,
                Item: {
                  pk: this.partitionKey,
                  sk: HEAD_SORT_KEY,
                  sequence: entry.sequence,
                  entryHash: entry.entryHash,
                  voucherId: entry.voucherId,
                },
              },
            },
          ],
        }),
      );
    } catch (error) {
      if (isConditionalCheckFailure(error)) {
        throw new ChainConflictError(expectHead.sequence, expectHead.sequence + 1);
      }
      throw error;
    }
  }

  async updateCheckpoints(checkpoints: readonly ChainCheckpoint[]): Promise<void> {
    await this.client.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: { pk: this.partitionKey, sk: META_SORT_KEY },
        UpdateExpression: 'SET #checkpoints = :checkpoints',
        ExpressionAttributeNames: { '#checkpoints': 'checkpoints' },
        ExpressionAttributeValues: { ':checkpoints': JSON.stringify(checkpoints) },
      }),
    );
  }

  /** アーカイブを初期化する（メタ情報を書く）。既にあれば何もしない。 */
  async initialize(params: {
    readonly createdAt: string;
    readonly retentionYears: number;
    readonly worm: boolean;
  }): Promise<void> {
    await this.client.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          pk: this.partitionKey,
          sk: META_SORT_KEY,
          archiveId: this.archiveId,
          createdAt: params.createdAt,
          retentionYears: params.retentionYears,
          worm: params.worm,
          checkpoints: '[]',
        },
        ConditionExpression: 'attribute_not_exists(pk)',
      }),
    ).catch((error: unknown) => {
      // 既に初期化済みなら成功扱い（冪等）。
      if (isConditionalCheckFailure(error)) {
        return;
      }
      throw error;
    });
  }

  /** 台帳エントリを順に読み出す。 */
  private async readEntries(): Promise<readonly LedgerEntry[]> {
    const entries: LedgerEntry[] = [];
    let exclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const response = await this.client.send(
        new QueryCommand({
          TableName: this.tableName,
          KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
          ExpressionAttributeValues: { ':pk': this.partitionKey, ':prefix': ENTRY_PREFIX },
          ScanIndexForward: true,
          ...(exclusiveStartKey === undefined ? {} : { ExclusiveStartKey: exclusiveStartKey }),
        }),
      );
      for (const item of response.Items ?? []) {
        entries.push(toLedgerEntry(item as Record<string, unknown>));
      }
      exclusiveStartKey = response.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (exclusiveStartKey !== undefined);
    return entries;
  }
}

/** エントリのソートキー（位置の昇順で並ぶようゼロ詰め）。 */
function entrySortKey(sequence: number): string {
  return `${ENTRY_PREFIX}${String(sequence).padStart(ENTRY_SORT_KEY_WIDTH, '0')}`;
}

/** アイテムから台帳エントリを復元する。 */
function toLedgerEntry(item: Record<string, unknown>): LedgerEntry {
  return {
    sequence: Number(item['sequence']),
    voucherId: String(item['voucherId']),
    objectKey: String(item['objectKey']),
    contentSha256: String(item['contentSha256']),
    metadataSha256: String(item['metadataSha256']),
    timestampSha256: item['timestampSha256'] === null || item['timestampSha256'] === undefined ? null : String(item['timestampSha256']),
    recordedAt: String(item['recordedAt']),
    previousEntryHash: String(item['previousEntryHash']),
    entryHash: String(item['entryHash']),
  };
}

/** チェックポイントを JSON 文字列から復元する。 */
function parseCheckpoints(value: unknown): readonly ChainCheckpoint[] {
  if (typeof value !== 'string') {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as ChainCheckpoint[]) : [];
  } catch {
    return [];
  }
}

/** 条件チェック失敗（楽観的排他制御の競合）か。 */
function isConditionalCheckFailure(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const name = (error as { name?: string }).name;
  if (name === 'TransactionCanceledException' || name === 'ConditionalCheckFailedException') {
    return true;
  }
  const reasons = (error as { CancellationReasons?: { Code?: string }[] }).CancellationReasons;
  return Array.isArray(reasons) && reasons.some((reason) => reason.Code === 'ConditionalCheckFailed');
}
