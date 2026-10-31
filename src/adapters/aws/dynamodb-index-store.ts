/**
 * DynamoDB を検索索引にした IndexStore。
 *
 * テーブルは 1 本（`pk` / `sk` の汎用キー）。索引の種類は
 * `pk = "<index>|<partitionKey>"` の前置きで表現する。
 * こうすると DynamoDB のテーブル/GSI を増やさずに論理的な索引を分けられ、
 * 索引とクエリの対応をアプリ側で明示できる。
 */
import {
  BatchWriteCommand,
  QueryCommand,
  ScanCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { IntegrityError } from '../../core/errors.js';
import type { IndexEntry, IndexName, IndexQuery, IndexRecord, IndexStore } from '../../core/types.js';

/** DynamoDB 索引アダプタの設定。 */
export interface DynamoDbIndexStoreOptions {
  readonly tableName: string;
  readonly client: DynamoDBDocumentClient;
}

/** バッチ書き込みの最大件数（DynamoDB の制限）。 */
const BATCH_SIZE = 25;

/** 索引アイテムの属性。 */
interface IndexItem {
  readonly pk: string;
  readonly sk: string;
  readonly voucherId: string;
  readonly transactionDate: string;
  readonly amountYen: number;
  readonly counterpartyNormalized: string;
  readonly documentType: string;
  readonly sequence: number;
}

/** DynamoDB 実装の IndexStore。 */
export class DynamoDbIndexStore implements IndexStore {
  private readonly tableName: string;
  private readonly client: DynamoDBDocumentClient;

  constructor(options: DynamoDbIndexStoreOptions) {
    this.tableName = options.tableName;
    this.client = options.client;
  }

  async put(entries: readonly IndexEntry[]): Promise<void> {
    const items = entries.map((entry) => toItem(entry));
    await this.batchWrite(items, 'PUT');
  }

  async query(query: IndexQuery): Promise<readonly IndexRecord[]> {
    const pk = `${query.index}|${query.partitionKey}`;
    const hasRange = query.sortKeyFrom !== undefined && query.sortKeyTo !== undefined;
    const command = new QueryCommand({
      TableName: this.tableName,
      KeyConditionExpression: hasRange
        ? 'pk = :pk AND sk BETWEEN :from AND :to'
        : 'pk = :pk',
      ExpressionAttributeValues: hasRange
        ? { ':pk': pk, ':from': query.sortKeyFrom, ':to': query.sortKeyTo }
        : { ':pk': pk },
    });
    const response = await this.client.send(command);
    return (response.Items ?? []).map((item) => toRecord(item as IndexItem));
  }

  /**
   * 索引を全件入れ替える。
   *
   * 台帳から索引を復旧する管理操作でのみ使うため、全件削除→再投入という
   * 素朴な実装にしている。件数が多い場合は並列度とスロットリングの調整が必要。
   */
  async rebuild(entries: readonly IndexEntry[]): Promise<void> {
    const existing = await this.scanAll();
    await this.batchWrite(existing, 'DELETE');
    await this.batchWrite(entries.map((entry) => toItem(entry)), 'PUT');
  }

  async stats(): Promise<Readonly<Record<IndexName, number>>> {
    const names: readonly IndexName[] = [
      'by-date',
      'by-amount',
      'by-counterparty',
      'by-counterparty-date',
      'by-counterparty-amount',
    ];
    const counts = {} as Record<IndexName, number>;
    for (const name of names) {
      const response = await this.client.send(
        new ScanCommand({
          TableName: this.tableName,
          Select: 'COUNT',
          FilterExpression: 'begins_with(pk, :prefix)',
          ExpressionAttributeValues: { ':prefix': `${name}|` },
        }),
      );
      counts[name] = response.Count ?? 0;
    }
    return counts;
  }

  /** 全件を走査する（管理操作専用）。 */
  private async scanAll(): Promise<readonly IndexItem[]> {
    const items: IndexItem[] = [];
    let lastKey: Record<string, unknown> | undefined;
    do {
      const response = await this.client.send(
        new ScanCommand({
          TableName: this.tableName,
          ...(lastKey === undefined ? {} : { ExclusiveStartKey: lastKey }),
        }),
      );
      for (const item of response.Items ?? []) {
        items.push(item as IndexItem);
      }
      lastKey = response.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (lastKey !== undefined);
    return items;
  }

  /** 25 件ずつまとめて書き込む。 */
  private async batchWrite(items: readonly IndexItem[], mode: 'PUT' | 'DELETE'): Promise<void> {
    for (let offset = 0; offset < items.length; offset += BATCH_SIZE) {
      const chunk = items.slice(offset, offset + BATCH_SIZE);
      const requests = chunk.map((item) =>
        mode === 'PUT' ? { PutRequest: { Item: item } } : { DeleteRequest: { Key: { pk: item.pk, sk: item.sk } } },
      );
      try {
        await this.client.send(
          new BatchWriteCommand({
            RequestItems: { [this.tableName]: requests },
          }),
        );
      } catch (error) {
        throw new IntegrityError('検索索引の書き込みに失敗しました', {
          table: this.tableName,
          count: chunk.length,
          cause: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}

/** 索引の 1 件をアイテムへ変換する。 */
function toItem(entry: IndexEntry): IndexItem {
  return {
    pk: `${entry.index}|${entry.partitionKey}`,
    sk: entry.sortKey,
    voucherId: entry.record.voucherId,
    transactionDate: entry.record.transactionDate,
    amountYen: entry.record.amountYen,
    counterpartyNormalized: entry.record.counterpartyNormalized,
    documentType: entry.record.documentType,
    sequence: entry.record.sequence,
  };
}

/** アイテムをレコードへ変換する。 */
function toRecord(item: IndexItem): IndexRecord {
  return {
    voucherId: item.voucherId,
    transactionDate: item.transactionDate,
    amountYen: item.amountYen,
    counterpartyNormalized: item.counterpartyNormalized,
    documentType: item.documentType as IndexRecord['documentType'],
    sequence: item.sequence,
  };
}
