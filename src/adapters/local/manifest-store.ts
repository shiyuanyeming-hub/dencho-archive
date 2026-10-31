/**
 * ローカルファイル 1 本を台帳（マニフェスト）の保存先とするアダプタ。
 *
 * 台帳は JSON 1 ファイルとして保存する。エントリの追記は
 * 「読む → 先頭（末尾）が期待どおりか確認する → 一時ファイルに書く → rename」
 * の順で行う。rename は同一ファイルシステム上で原子的なので、書き込み途中の
 * 半端な JSON が読まれることはない。
 *
 * 楽観的排他制御（OCC）:
 * `append(entry, expectHead)` は呼び出し側が「追記前に読んだ末尾」を渡す。
 * その間に別の書き込みで末尾が変わっていれば `ChainConflictError` を投げ、
 * 呼び出し側は読み直してリトライする。台帳の追記漏れ・分岐を防ぐための仕組み。
 *
 * 制約: ローカル実装はマルチプロセス同時書き込みを完全には排他しない
 * （read と rename の間の競合は理論上残る）。OCC は「読んだ時点から末尾が
 * 変わった」ことを検出するためのもので、分散環境の強整合性は本番の
 * DynamoDB トランザクション（アダプタ差し替え）で担保する。
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { computeEntryHash } from '../../core/chain.js';
import { ChainConflictError, IntegrityError, NotFoundError, ValidationError } from '../../core/errors.js';
import { ZERO_HASH, hashesEqual, isSha256Hex } from '../../core/hash.js';
import { isValidIsoInstant } from '../../core/time.js';
import type {
  ArchiveManifest,
  ChainCheckpoint,
  IsoInstant,
  LedgerEntry,
  ManifestStore,
  Sha256Hex,
} from '../../core/types.js';

/**
 * `createArchiveManifest` の入力。
 *
 * 台帳の不変ヘッダ（アーカイブ ID・作成時刻・保存期間・WORM かどうか）を決める。
 */
export interface CreateArchiveManifestParams {
  /** アーカイブの識別子。 */
  readonly archiveId: string;
  /** アーカイブの作成時刻（オフセット付き RFC3339）。 */
  readonly createdAt: IsoInstant;
  /** 保存期間（年）。法定は 7 年。 */
  readonly retentionYears: number;
  /** WORM（書き込み後変更不可）の保存先かどうか。 */
  readonly worm: boolean;
}

/**
 * 空の台帳（マニフェスト）を作る。
 *
 * エントリとチェックポイントは空配列で開始する。台帳を最初に作るときは
 * このマニフェストを `LocalManifestStore` の `initial` に渡す。
 *
 * @throws ValidationError 入力が不正な場合。
 */
export function createArchiveManifest(params: CreateArchiveManifestParams): ArchiveManifest {
  const archiveId = typeof params.archiveId === 'string' ? params.archiveId.trim() : '';
  if (archiveId.length === 0) {
    throw new ValidationError('archiveId は必須です');
  }
  if (typeof params.createdAt !== 'string' || !isValidIsoInstant(params.createdAt)) {
    throw new ValidationError('createdAt はオフセット付き RFC3339 で指定してください', {
      createdAt: String(params.createdAt),
    });
  }
  if (!Number.isInteger(params.retentionYears) || params.retentionYears < 1) {
    throw new ValidationError('retentionYears は 1 以上の整数で指定してください', {
      retentionYears: params.retentionYears,
    });
  }
  if (typeof params.worm !== 'boolean') {
    throw new ValidationError('worm は boolean で指定してください');
  }
  return {
    schemaVersion: 1,
    archiveId,
    createdAt: params.createdAt,
    retentionYears: params.retentionYears,
    worm: params.worm,
    entries: [],
    checkpoints: [],
  };
}

/**
 * `LocalManifestStore` の生成オプション。
 */
export interface LocalManifestStoreOptions {
  /**
   * 台帳ファイルがまだ存在しないときに使う初期マニフェスト。
   *
   * 省略した場合、ファイルが無い状態での `read()` は `NotFoundError` になる。
   */
  readonly initial?: ArchiveManifest;
}

/**
 * JSON ファイル 1 本で台帳を保存する `ManifestStore` 実装。
 *
 * `append` は楽観的排他制御を行い、`expectHead` が現在の末尾と一致しない場合は
 * `ChainConflictError` を投げる。
 */
export class LocalManifestStore implements ManifestStore {
  /** 台帳ファイルの絶対パス。 */
  private readonly filePath: string;
  /** ファイルが無いときに使う初期マニフェスト（コピーを保持する）。 */
  private readonly initial: ArchiveManifest | null;

  /**
   * @param filePath 台帳 JSON の保存パス（親ディレクトリは書き込み時に作成する）。
   * @param options 初期マニフェストなどのオプション。
   * @throws ValidationError パスが空の場合。
   */
  constructor(filePath: string, options?: LocalManifestStoreOptions) {
    if (typeof filePath !== 'string' || filePath.trim().length === 0) {
      throw new ValidationError('台帳ファイルのパスを指定してください');
    }
    this.filePath = resolve(filePath);
    const initial = options?.initial;
    this.initial = initial === undefined ? null : cloneManifest(initial);
  }

  /**
   * 台帳を読み出す。
   *
   * @throws NotFoundError ファイルが無く、初期マニフェストも無い場合。
   * @throws IntegrityError ファイルが JSON として壊れている、または構造が不正な場合。
   */
  async read(): Promise<ArchiveManifest> {
    let text: string;
    try {
      text = await readFile(this.filePath, 'utf8');
    } catch (error) {
      if (isEnoent(error)) {
        if (this.initial !== null) {
          // 初期値は呼び出し側と共有しない（書き換えられても次回に影響しないように）。
          return cloneManifest(this.initial);
        }
        throw new NotFoundError(`台帳ファイルが見つかりません: ${this.filePath}`, { filePath: this.filePath });
      }
      throw error;
    }
    return parseManifest(text, this.filePath);
  }

  /**
   * 台帳へ 1 件追記する。
   *
   * 現在の末尾（空なら番号 0・ハッシュ null）を再読込して `expectHead` と比較し、
   * 一致したときだけ追記する。さらに「連番が続いていること」「直前エントリと
   * 連結していること」「`entryHash` が内容と一致すること」を検証する。
   *
   * @throws ChainConflictError 読み出し後に末尾が変わっていた場合。
   * @throws ValidationError 連番・連結・エントリハッシュが不正な場合。
   * @throws NotFoundError 台帳ファイルが無く、初期マニフェストも無い場合。
   */
  async append(
    entry: LedgerEntry,
    expectHead: { readonly sequence: number; readonly entryHash: Sha256Hex | null },
  ): Promise<void> {
    const current = await this.read();
    const head = current.entries.length === 0 ? null : (current.entries[current.entries.length - 1] ?? null);
    const actualSequence = head === null ? 0 : head.sequence;
    const actualHash = head === null ? null : head.entryHash;

    if (expectHead.sequence !== actualSequence || !optionalHashesEqual(expectHead.entryHash, actualHash)) {
      throw new ChainConflictError(expectHead.sequence, actualSequence);
    }

    const expectedSequence = actualSequence + 1;
    if (entry.sequence !== expectedSequence) {
      throw new ValidationError(
        `追記するエントリの sequence は ${String(expectedSequence)} でなければなりません`,
        { expectedSequence, actualSequence: entry.sequence },
      );
    }
    const expectedPreviousHash = head === null ? ZERO_HASH : head.entryHash;
    if (!hashesEqual(entry.previousEntryHash, expectedPreviousHash)) {
      throw new ValidationError('追記するエントリの previousEntryHash が現在の末尾と連結していません', {
        expectedPreviousHash,
        actualPreviousHash: entry.previousEntryHash,
      });
    }
    const recomputedEntryHash = computeEntryHash(entry);
    if (!hashesEqual(recomputedEntryHash, entry.entryHash)) {
      throw new ValidationError('追記するエントリの entryHash が内容から再計算した値と一致しません', {
        computed: recomputedEntryHash,
        actual: entry.entryHash,
      });
    }

    await this.write({ ...current, entries: [...current.entries, entry] });
  }

  /**
   * チェックポイントを丸ごと置き換える。
   *
   * チェックポイントは台帳末尾のハッシュの控えであり、後から検証して
   * 末尾の切捨てを検出するために使う。
   *
   * @throws ValidationError チェックポイントの形式が不正な場合。
   * @throws NotFoundError 台帳ファイルが無く、初期マニフェストも無い場合。
   */
  async updateCheckpoints(checkpoints: readonly ChainCheckpoint[]): Promise<void> {
    for (const checkpoint of checkpoints) {
      if (!isChainCheckpoint(checkpoint)) {
        throw new ValidationError('チェックポイントの形式が不正です', {
          sequence: isRecord(checkpoint) ? checkpoint['sequence'] : null,
        });
      }
    }
    const current = await this.read();
    await this.write({ ...current, checkpoints: checkpoints.map((checkpoint) => ({ ...checkpoint })) });
  }

  /** 台帳を原子的に書き込む（一時ファイル + rename）。 */
  private async write(manifest: ArchiveManifest): Promise<void> {
    const dir = dirname(this.filePath);
    await mkdir(dir, { recursive: true });
    const tmpPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      // 人が読めるよう整形して保存する（改ざん検証はハッシュチェーンが担う）。
      await writeFile(tmpPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
      await rename(tmpPath, this.filePath);
    } catch (error) {
      await rm(tmpPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}

// ---------------------------------------------------------------------------
// 内部ヘルパー
// ---------------------------------------------------------------------------

/** 台帳 JSON を解析し、構造が正しいことを確認する。 */
function parseManifest(text: string, filePath: string): ArchiveManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new IntegrityError(`台帳ファイルが JSON として解析できません: ${filePath}`, { filePath });
  }
  if (!isArchiveManifest(raw)) {
    throw new IntegrityError('台帳ファイルの構造が不正です（改ざん・破損の可能性）', { filePath });
  }
  return raw;
}

/** マニフェストのコピーを作る（配列・要素まで複製する）。 */
function cloneManifest(manifest: ArchiveManifest): ArchiveManifest {
  return {
    ...manifest,
    entries: manifest.entries.map((entry) => ({ ...entry })),
    checkpoints: manifest.checkpoints.map((checkpoint) => ({ ...checkpoint })),
  };
}

/** ハッシュ（null 可）同士の比較。 */
function optionalHashesEqual(left: Sha256Hex | null, right: Sha256Hex | null): boolean {
  if (left === null || right === null) {
    return left === right;
  }
  return hashesEqual(left, right);
}

/** ファイルが無いことによるエラーかを判定する。 */
function isEnoent(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT';
}

/** 素朴なオブジェクト（配列・null を除く）か。 */
function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** SHA-256 の 16 進 64 文字か。 */
function isSha256Value(value: unknown): value is Sha256Hex {
  return typeof value === 'string' && isSha256Hex(value);
}

/** 保存されたマニフェストの構造検証（値の正しさはハッシュチェーン検証が担う）。 */
function isArchiveManifest(value: unknown): value is ArchiveManifest {
  if (!isRecord(value)) {
    return false;
  }
  if (value['schemaVersion'] !== 1) {
    return false;
  }
  if (typeof value['archiveId'] !== 'string' || value['archiveId'].length === 0) {
    return false;
  }
  if (typeof value['createdAt'] !== 'string' || !isValidIsoInstant(value['createdAt'])) {
    return false;
  }
  if (typeof value['retentionYears'] !== 'number' || !Number.isInteger(value['retentionYears'])) {
    return false;
  }
  if (typeof value['worm'] !== 'boolean') {
    return false;
  }
  const entries = value['entries'];
  if (!Array.isArray(entries) || !entries.every(isLedgerEntry)) {
    return false;
  }
  const checkpoints = value['checkpoints'];
  if (!Array.isArray(checkpoints) || !checkpoints.every(isChainCheckpoint)) {
    return false;
  }
  return true;
}

/** 台帳エントリの構造検証。 */
function isLedgerEntry(value: unknown): value is LedgerEntry {
  if (!isRecord(value)) {
    return false;
  }
  if (typeof value['sequence'] !== 'number' || !Number.isInteger(value['sequence']) || value['sequence'] < 1) {
    return false;
  }
  if (typeof value['voucherId'] !== 'string' || value['voucherId'].length === 0) {
    return false;
  }
  if (typeof value['objectKey'] !== 'string' || value['objectKey'].length === 0) {
    return false;
  }
  if (!isSha256Value(value['contentSha256']) || !isSha256Value(value['metadataSha256'])) {
    return false;
  }
  const timestampSha256 = value['timestampSha256'];
  if (timestampSha256 !== null && !isSha256Value(timestampSha256)) {
    return false;
  }
  if (typeof value['recordedAt'] !== 'string' || !isValidIsoInstant(value['recordedAt'])) {
    return false;
  }
  if (!isSha256Value(value['previousEntryHash']) || !isSha256Value(value['entryHash'])) {
    return false;
  }
  return true;
}

/** チェックポイントの構造検証。 */
function isChainCheckpoint(value: unknown): value is ChainCheckpoint {
  if (!isRecord(value)) {
    return false;
  }
  if (typeof value['sequence'] !== 'number' || !Number.isInteger(value['sequence']) || value['sequence'] < 1) {
    return false;
  }
  if (!isSha256Value(value['entryHash'])) {
    return false;
  }
  if (typeof value['recordedAt'] !== 'string' || !isValidIsoInstant(value['recordedAt'])) {
    return false;
  }
  const signature = value['signature'];
  if (signature !== undefined && typeof signature !== 'string') {
    return false;
  }
  return true;
}
