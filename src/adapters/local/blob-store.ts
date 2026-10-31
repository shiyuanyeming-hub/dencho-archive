/**
 * ローカルファイルシステム上のブロブストア。
 *
 * 証憑データ本体とメタデータ封筒を「内容アドレス（SHA-256）」をキーに保存する。
 * 本番構成では S3（Object Lock による WORM）に置き換えるが、ローカルでも
 * 同じ「内容が同じなら同じキー・上書き不可」という性質を再現する。
 *
 * 設計方針:
 * - キーは保存先からの相対パス。`..` や絶対パスはパストラバーサルとして拒否する。
 * - 書き込みは一時ファイル + rename による原子的な差し替え。途中で落ちても
 *   半端なファイルが見えない。
 * - 同じキーに異なる内容を書こうとした場合は `IntegrityError`。内容アドレス
 *   ストアにおいてこれは「ハッシュ衝突か改ざん」のどちらかであり、
 *   黙って上書きしてはいけない（WORM の前提を壊す）。
 * - 同じ内容の再書き込みは冪等に成功させる（再取り込み・再試行のため）。
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, relative, resolve } from 'node:path';
import { IntegrityError, NotFoundError, ValidationError } from '../../core/errors.js';
import type { BlobStore } from '../../core/types.js';

/**
 * ローカルディレクトリを保存先とする `BlobStore` 実装。
 *
 * 1 つのルートディレクトリ配下に `<key>` のパスでファイルを置く。
 * `LocalBlobStore` は `BlobStore` インタフェース以外に `reset()`（全消去）を持ち、
 * デモ・テストでアーカイブを作り直すために使う。
 */
export class LocalBlobStore implements BlobStore {
  /** 保存先のルートディレクトリ（絶対パス）。 */
  private readonly rootDir: string;

  /**
   * @param rootDir 保存先のルートディレクトリ。無ければ書き込み時に作成する。
   * @throws ValidationError 空文字やファイルシステムのルートが指定された場合。
   */
  constructor(rootDir: string) {
    if (typeof rootDir !== 'string' || rootDir.trim().length === 0) {
      throw new ValidationError('ブロブの保存先ディレクトリを指定してください');
    }
    const resolved = resolve(rootDir);
    // ルートそのものを保存先にすると reset() で全消去しかねないため拒否する。
    if (parse(resolved).root === resolved) {
      throw new ValidationError('ファイルシステムのルートを保存先には指定できません', { rootDir: resolved });
    }
    this.rootDir = resolved;
  }

  /**
   * ブロブを保存する。既に同じキーで同じ内容が保存されていれば何もしない。
   *
   * @throws ValidationError キーが不正（空・`..` を含む・絶対パス）な場合。
   * @throws IntegrityError 同じキーに異なる内容が既に保存されている場合。
   */
  async put(key: string, data: Uint8Array): Promise<void> {
    const filePath = this.pathFor(key);
    if (!(data instanceof Uint8Array)) {
      throw new ValidationError('保存するデータは Uint8Array で指定してください', { key });
    }

    const existing = await readFileIfExists(filePath);
    if (existing !== null) {
      if (existing.equals(data)) {
        return;
      }
      throw new IntegrityError(
        '同じキーに異なる内容が書き込まれました（内容アドレス保存の前提が壊れています）',
        { key },
      );
    }

    await mkdir(dirname(filePath), { recursive: true });
    const tmpPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(tmpPath, data);
      await rename(tmpPath, filePath);
    } catch (error) {
      await rm(tmpPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  /**
   * ブロブを読み出す。
   *
   * @throws ValidationError キーが不正な場合。
   * @throws NotFoundError ブロブが存在しない場合。
   */
  async get(key: string): Promise<Uint8Array> {
    const filePath = this.pathFor(key);
    const data = await readFileIfExists(filePath);
    if (data === null) {
      throw new NotFoundError(`ブロブが見つかりません: ${key}`, { key });
    }
    return data;
  }

  /**
   * ブロブが存在するかを返す。
   *
   * @throws ValidationError キーが不正な場合。
   */
  async has(key: string): Promise<boolean> {
    const filePath = this.pathFor(key);
    try {
      const info = await stat(filePath);
      return info.isFile();
    } catch (error) {
      if (isEnoent(error)) {
        return false;
      }
      throw error;
    }
  }

  /**
   * 保存済みキーを辞書順で返す。
   *
   * @param prefix 指定した場合、その接頭辞で始まるキーだけを返す。
   */
  async list(prefix?: string): Promise<readonly string[]> {
    const keys: string[] = [];
    await collectKeys(this.rootDir, '', keys);
    const filtered = prefix === undefined ? keys : keys.filter((key) => key.startsWith(prefix));
    return filtered.sort();
  }

  /**
   * 保存先を空にする（デモ・テスト用）。
   *
   * ルートディレクトリごと削除して作り直す。途中の一時ファイルも消える。
   */
  async reset(): Promise<void> {
    await rm(this.rootDir, { recursive: true, force: true });
    await mkdir(this.rootDir, { recursive: true });
  }

  /** キーを保存先配下の絶対パスへ変換し、保存先の外を指していないか確認する。 */
  private pathFor(key: string): string {
    assertSafeKey(key);
    const fullPath = resolve(this.rootDir, key);
    const rel = relative(this.rootDir, fullPath);
    if (rel.length === 0 || rel.startsWith('..') || isAbsolute(rel)) {
      throw new ValidationError('保存キーが保存先ディレクトリの外を指しています', { key });
    }
    return fullPath;
  }
}

// ---------------------------------------------------------------------------
// 内部ヘルパー
// ---------------------------------------------------------------------------

/**
 * 保存キーの安全性を検証する。
 *
 * 内容アドレスのキーは `objects/ab/cd/<hash>` のような相対パスだけであり、
 * それ以外（絶対パス・親ディレクトリ参照）は受け付けない。
 */
function assertSafeKey(key: string): void {
  if (typeof key !== 'string' || key.trim().length === 0) {
    throw new ValidationError('保存キーは必須です');
  }
  if (key.includes('\u0000')) {
    throw new ValidationError('保存キーに NUL 文字は使えません', { key });
  }
  if (key.includes('..')) {
    throw new ValidationError('保存キーに ".." を含めることはできません（パストラバーサル防止）', { key });
  }
  if (key.startsWith('/') || isAbsolute(key)) {
    throw new ValidationError('保存キーは絶対パスであってはなりません（パストラバーサル防止）', { key });
  }
}

/** ファイルを読む。存在しなければ null。 */
async function readFileIfExists(filePath: string): Promise<Buffer | null> {
  try {
    return await readFile(filePath);
  } catch (error) {
    if (isEnoent(error)) {
      return null;
    }
    throw error;
  }
}

/** ディレクトリ配下のファイルをキー（`/` 区切り）として収集する。 */
async function collectKeys(dir: string, relPrefix: string, out: string[]): Promise<void> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    if (isEnoent(error)) {
      return;
    }
    throw error;
  }
  for (const name of names) {
    // 書き込み途中の一時ファイル（rename 前）はブロブとして公開しない。
    if (name.endsWith('.tmp')) {
      continue;
    }
    const childRel = relPrefix.length === 0 ? name : `${relPrefix}/${name}`;
    const childPath = join(dir, name);
    const info = await stat(childPath);
    if (info.isDirectory()) {
      await collectKeys(childPath, childRel, out);
    } else if (info.isFile()) {
      out.push(childRel);
    }
  }
}

/** ファイルが無いことによるエラーかを判定する。 */
function isEnoent(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT';
}
