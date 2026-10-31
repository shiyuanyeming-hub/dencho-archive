/**
 * ローカルファイル実装の検索索引ストア。
 *
 * 索引を JSON ファイル 1 本へ永続化する。目的は「CLI の別プロセスからでも
 * 検索できること」であり、`ingest` したプロセスと `search` するプロセスが
 * 別でも索引が共有される（DynamoDB の `voucher-index` テーブルの代替）。
 *
 * 設計方針:
 * - 書き込みは**一時ファイル + `rename`** による原子的置換。読み手は
 *   書きかけの JSON を見ることがない（`rename` は同一ディレクトリ内で原子的）。
 * - 書き込みはインスタンス内で直列化する。索引は台帳から再構築できる派生物
 *   （`rebuild`）なので、複数プロセスからの同時書き込みは想定せず、
 *   その場合は再構築で整合を取る。
 * - 読み込み時に構造を検証する。壊れた JSON を黙って空索引として扱うと
 *   「検索結果が 0 件」という誤った成功になるため、`IntegrityError` とする。
 * - `query` は `partitionKey` 完全一致 + `sortKey` の範囲（両端含む）で絞り、
 *   ソートキー昇順で返す（DynamoDB の Query と同じ意味）。
 */

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type {
  DocumentType,
  IndexEntry,
  IndexName,
  IndexQuery,
  IndexRecord,
  IndexStore,
} from '../../core/types.js';
import { INDEX_NAMES } from '../../core/index-keys.js';
import { IntegrityError, ValidationError } from '../../core/errors.js';
import { isValidIsoDate } from '../../core/time.js';

// ---------------------------------------------------------------------------
// ファイル形式
// ---------------------------------------------------------------------------

/** 索引ファイルの封筒（将来の形式変更に備えて `schemaVersion` を持つ）。 */
interface IndexFile {
  readonly schemaVersion: 1;
  readonly entries: readonly IndexEntry[];
}

/** 索引ファイルの現行スキーマ版。 */
const INDEX_FILE_SCHEMA_VERSION = 1;

/** 有効な書類種別（ファイルから読み出した値の実行時検証に使う）。 */
const DOCUMENT_TYPES: readonly DocumentType[] = [
  'invoice',
  'receipt',
  'delivery-note',
  'contract',
  'order',
  'statement',
  'other',
];

/** 索引名の表示順（ファイル出力順と `stats` の順序を固定する）。 */
const INDEX_ORDER: ReadonlyMap<IndexName, number> = new Map(
  INDEX_NAMES.map((name, position): [IndexName, number] => [name, position]),
);

// ---------------------------------------------------------------------------
// ストア本体
// ---------------------------------------------------------------------------

/**
 * JSON ファイルを索引の保存先とする `IndexStore` 実装。
 *
 * 使い方:
 * ```ts
 * const store = new LocalIndexStore('/path/to/index.json');
 * await store.put(deriveIndexEntries(record)); // 追記（同一 pk/sk は上書き）
 * const records = await store.query({ index: 'by-date', partitionKey: 'D#2026-10' });
 * ```
 *
 * ファイルが存在しない場合は空の索引として扱う。
 * ファイルの内容が壊れている場合は `IntegrityError` を投げる。
 */
export class LocalIndexStore implements IndexStore {
  /** 索引 JSON の保存先。 */
  private readonly filePath: string;
  /** 読み込み済みの索引（`null` は未読み込み）。キーは索引名 + pk + sk。 */
  private entries: Map<string, IndexEntry> | null = null;
  /** 書き込みを直列化するための待ち行列の末尾。 */
  private writeTail: Promise<unknown> = Promise.resolve();

  /**
   * @param filePath 索引 JSON の保存先パス（存在しなくてよい。親ディレクトリは自動作成）
   * @throws ValidationError パスが空の場合
   */
  constructor(filePath: string) {
    if (filePath.trim().length === 0) {
      throw new ValidationError('索引ファイルのパスが空です');
    }
    this.filePath = filePath;
  }

  /**
   * 索引エントリを追加する。
   *
   * 同じ `index` + `partitionKey` + `sortKey` のエントリは上書きされる
   * （DynamoDB の PutItem と同じ意味）。書き込みは直列化され、ファイルは
   * 一時ファイル + `rename` で原子的に置き換わる。
   */
  async put(entries: readonly IndexEntry[]): Promise<void> {
    await this.enqueue(async () => {
      const current = await this.ensureLoaded();
      for (const entry of entries) {
        assertValidEntry(entry);
        current.set(indexEntryKey(entry), entry);
      }
      await this.persist(current);
    });
  }

  /**
   * 単一パーティションを `sortKey` の範囲（両端含む）で読み出す。
   *
   * 結果はソートキー昇順。該当が無ければ空配列を返す（エラーにしない）。
   */
  async query(query: IndexQuery): Promise<readonly IndexRecord[]> {
    const current = await this.ensureLoaded();
    const matched: IndexEntry[] = [];
    for (const entry of current.values()) {
      if (entry.index !== query.index || entry.partitionKey !== query.partitionKey) {
        continue;
      }
      if (query.sortKeyFrom !== undefined && entry.sortKey < query.sortKeyFrom) {
        continue;
      }
      if (query.sortKeyTo !== undefined && entry.sortKey > query.sortKeyTo) {
        continue;
      }
      matched.push(entry);
    }
    matched.sort((left, right) => compareStrings(left.sortKey, right.sortKey));
    return matched.map((entry) => entry.record);
  }

  /**
   * 索引を全件入れ替える（障害復旧・スキーマ移行のための再構築用）。
   *
   * 既存の内容は破棄され、渡したエントリだけになる。
   */
  async rebuild(entries: readonly IndexEntry[]): Promise<void> {
    await this.enqueue(async () => {
      const next = new Map<string, IndexEntry>();
      for (const entry of entries) {
        assertValidEntry(entry);
        next.set(indexEntryKey(entry), entry);
      }
      this.entries = next;
      await this.persist(next);
    });
  }

  /**
   * 索引ごとのエントリ数を返す（分散具合の診断用）。
   *
   * すべての索引名をキーとして必ず含む（0 件の索引も 0 として返す）。
   */
  async stats(): Promise<Readonly<Record<IndexName, number>>> {
    const current = await this.ensureLoaded();
    const counts: Record<IndexName, number> = {
      'by-date': 0,
      'by-amount': 0,
      'by-counterparty': 0,
      'by-counterparty-date': 0,
      'by-counterparty-amount': 0,
    };
    for (const entry of current.values()) {
      counts[entry.index] += 1;
    }
    return counts;
  }

  // -------------------------------------------------------------------------
  // 内部
  // -------------------------------------------------------------------------

  /** 読み込み済み索引を返す（未読み込みならディスクから読む）。 */
  private async ensureLoaded(): Promise<Map<string, IndexEntry>> {
    if (this.entries !== null) {
      return this.entries;
    }
    const loaded = await this.loadFromDisk();
    this.entries = loaded;
    return loaded;
  }

  /** 索引 JSON を読み出す。ファイルが無ければ空。壊れていれば `IntegrityError`。 */
  private async loadFromDisk(): Promise<Map<string, IndexEntry>> {
    let text: string;
    try {
      text = await readFile(this.filePath, 'utf8');
    } catch (error: unknown) {
      if (isErrnoException(error) && error.code === 'ENOENT') {
        return new Map();
      }
      throw new IntegrityError(`索引ファイルを読み出せません: ${this.filePath}`, {
        reason: describeError(error),
      });
    }
    const entries = parseIndexFile(text, this.filePath);
    const map = new Map<string, IndexEntry>();
    for (const entry of entries) {
      map.set(indexEntryKey(entry), entry);
    }
    return map;
  }

  /** 索引を JSON ファイルへ原子的に書き出す。 */
  private async persist(entries: ReadonlyMap<string, IndexEntry>): Promise<void> {
    const sorted = [...entries.values()].sort(compareEntries);
    const document: IndexFile = { schemaVersion: INDEX_FILE_SCHEMA_VERSION, entries: sorted };
    const text = `${JSON.stringify(document, null, 2)}\n`;

    await mkdir(dirname(this.filePath), { recursive: true });
    // 一意な一時ファイルへ書いてから rename する（書きかけを読ませない）。
    const tempPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(tempPath, text, 'utf8');
      await rename(tempPath, this.filePath);
    } finally {
      // 失敗した場合に一時ファイルを残さない（成功時は既に消えている）。
      await rm(tempPath, { force: true });
    }
  }

  /** 書き込みを直列化する（前の書き込みが終わってから次を実行する）。 */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.writeTail.then(task, task);
    this.writeTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

// ---------------------------------------------------------------------------
// キーと順序
// ---------------------------------------------------------------------------

/** 索引エントリの同一性キー（DynamoDB の pk + sk に索引名を足したもの）。 */
function indexEntryKey(entry: { readonly index: IndexName; readonly partitionKey: string; readonly sortKey: string }): string {
  // \u0000 はキー中に現れないため区切りとして安全。
  return `${entry.index}\u0000${entry.partitionKey}\u0000${entry.sortKey}`;
}

/** ファイル出力順・同一性を決める比較（索引名 → pk → sk）。 */
function compareEntries(left: IndexEntry, right: IndexEntry): number {
  const leftOrder = INDEX_ORDER.get(left.index) ?? INDEX_NAMES.length;
  const rightOrder = INDEX_ORDER.get(right.index) ?? INDEX_NAMES.length;
  return (
    leftOrder - rightOrder ||
    compareStrings(left.partitionKey, right.partitionKey) ||
    compareStrings(left.sortKey, right.sortKey)
  );
}

/** 文字列の昇順比較（索引キーは ASCII 接頭辞のため、辞書順で安定する）。 */
function compareStrings(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

// ---------------------------------------------------------------------------
// 実行時検証
// ---------------------------------------------------------------------------

/** 型付き入力のエントリを検証する（未型付けの呼び出しからの破損書き込みを防ぐ）。 */
function assertValidEntry(entry: IndexEntry): void {
  if (!isIndexName(entry.index)) {
    throw new ValidationError(`不正な索引名です: ${String(entry.index)}`);
  }
  if (entry.partitionKey.length === 0 || entry.sortKey.length === 0) {
    throw new ValidationError('索引エントリのパーティションキー/ソートキーが空です');
  }
}

/** 索引ファイルの内容を検証しながらエントリ一覧へ変換する。 */
function parseIndexFile(text: string, filePath: string): readonly IndexEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new IntegrityError(`索引ファイルが JSON として解釈できません: ${filePath}`);
  }
  if (!isRecord(parsed) || parsed['schemaVersion'] !== INDEX_FILE_SCHEMA_VERSION) {
    throw new IntegrityError(`索引ファイルの schemaVersion が不正です（${INDEX_FILE_SCHEMA_VERSION} を期待）: ${filePath}`);
  }
  const rawEntries = parsed['entries'];
  if (!Array.isArray(rawEntries)) {
    throw new IntegrityError(`索引ファイルの entries が配列ではありません: ${filePath}`);
  }
  return rawEntries.map((raw, position) => parseEntry(raw, filePath, position));
}

/** 1 エントリを検証して型付きへ変換する。 */
function parseEntry(raw: unknown, filePath: string, position: number): IndexEntry {
  const where = `${filePath} の ${position} 番目のエントリ`;
  if (!isRecord(raw)) {
    throw new IntegrityError(`索引エントリがオブジェクトではありません: ${where}`);
  }
  const index = raw['index'];
  const partitionKey = raw['partitionKey'];
  const sortKey = raw['sortKey'];
  if (!isIndexName(index)) {
    throw new IntegrityError(`索引名が不正です: ${where}`);
  }
  if (typeof partitionKey !== 'string' || partitionKey.length === 0) {
    throw new IntegrityError(`partitionKey が不正です: ${where}`);
  }
  if (typeof sortKey !== 'string' || sortKey.length === 0) {
    throw new IntegrityError(`sortKey が不正です: ${where}`);
  }
  return { index, partitionKey, sortKey, record: parseRecord(raw['record'], where) };
}

/** 索引レコードを検証して型付きへ変換する。 */
function parseRecord(raw: unknown, where: string): IndexRecord {
  if (!isRecord(raw)) {
    throw new IntegrityError(`索引レコードがオブジェクトではありません: ${where}`);
  }
  const voucherId = raw['voucherId'];
  const transactionDate = raw['transactionDate'];
  const amountYen = raw['amountYen'];
  const counterpartyNormalized = raw['counterpartyNormalized'];
  const documentType = raw['documentType'];
  const sequence = raw['sequence'];

  if (typeof voucherId !== 'string' || voucherId.length === 0) {
    throw new IntegrityError(`voucherId が不正です: ${where}`);
  }
  if (typeof transactionDate !== 'string' || !isValidIsoDate(transactionDate)) {
    throw new IntegrityError(`transactionDate が不正です: ${where}`);
  }
  if (typeof amountYen !== 'number' || !Number.isSafeInteger(amountYen) || amountYen < 0) {
    throw new IntegrityError(`amountYen が不正です: ${where}`);
  }
  if (typeof counterpartyNormalized !== 'string' || counterpartyNormalized.length === 0) {
    throw new IntegrityError(`counterpartyNormalized が不正です: ${where}`);
  }
  if (!isDocumentType(documentType)) {
    throw new IntegrityError(`documentType が不正です: ${where}`);
  }
  if (typeof sequence !== 'number' || !Number.isInteger(sequence) || sequence < 1) {
    throw new IntegrityError(`sequence が不正です: ${where}`);
  }
  return {
    voucherId,
    transactionDate,
    amountYen,
    counterpartyNormalized,
    documentType,
    sequence,
  };
}

/** 値が索引名か。 */
function isIndexName(value: unknown): value is IndexName {
  return typeof value === 'string' && (INDEX_NAMES as readonly string[]).includes(value);
}

/** 値が書類種別か。 */
function isDocumentType(value: unknown): value is DocumentType {
  return typeof value === 'string' && (DOCUMENT_TYPES as readonly string[]).includes(value);
}

/** 値がプレーンオブジェクトか（配列・null を含まない）。 */
function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Node.js の errno 例外か（`code` を安全に読むため）。 */
function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

/** 例外を人が読める文字列にする。 */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
