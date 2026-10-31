/**
 * ローカルアダプタ（ブロブストア・マニフェストストア）のテスト。
 *
 * 検証する性質:
 * - 内容アドレス保存: 同じキーには同じ内容しか置けない（異なる内容は IntegrityError）
 * - パストラバーサル拒否: `..` や絶対パスをキーにできない
 * - 原子的な書き込み: 一時ファイル + rename。書き込み途中の半端な状態を見せない
 * - 追記の楽観的排他制御（OCC）: 期待した末尾が変わっていれば ChainConflictError
 * - 台帳ファイルの永続化: 別インスタンス・別プロセスから読める
 */
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalBlobStore } from '../../src/adapters/local/blob-store.js';
import {
  LocalManifestStore,
  createArchiveManifest,
} from '../../src/adapters/local/manifest-store.js';
import { GENESIS_PREVIOUS_HASH, createLedgerEntry } from '../../src/core/chain.js';
import { ChainConflictError, IntegrityError, NotFoundError, ValidationError } from '../../src/core/errors.js';
import { sha256HexOf } from '../../src/core/hash.js';
import type { ArchiveManifest, LedgerEntry, Sha256Hex } from '../../src/core/types.js';

const encoder = new TextEncoder();

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dencho-local-stores-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** 台帳エントリを組み立てる（ハッシュは内容から計算される）。 */
function makeEntry(sequence: number, previousEntryHash: Sha256Hex): LedgerEntry {
  return createLedgerEntry({
    sequence,
    voucherId: `V-${String(sequence).padStart(3, '0')}`,
    objectKey: `objects/${sequence}`,
    contentSha256: sha256HexOf({ sequence, kind: 'content' }),
    metadataSha256: sha256HexOf({ sequence, kind: 'metadata' }),
    timestampSha256: null,
    recordedAt: '2026-01-15T10:00:00+09:00',
    previousEntryHash,
  });
}

/** 空の台帳を作る。 */
function makeManifest(): ArchiveManifest {
  return createArchiveManifest({
    archiveId: 'arc-local',
    createdAt: '2026-01-01T09:00:00+09:00',
    retentionYears: 7,
    worm: true,
  });
}

describe('LocalBlobStore', () => {
  /** テスト用のブロブストア。 */
  function makeStore(): LocalBlobStore {
    return new LocalBlobStore(join(root, 'blobs'));
  }

  it('put したデータを get でそのまま取り出せる', async () => {
    const blobs = makeStore();
    const key = 'objects/ab/cd/0123';
    const data = encoder.encode('証憑データ本体');

    await blobs.put(key, data);
    expect(await blobs.has(key)).toBe(true);
    expect(new TextDecoder().decode(await blobs.get(key))).toBe('証憑データ本体');
  });

  it('存在しないキーの get は NotFoundError、has は false', async () => {
    const blobs = makeStore();
    await expect(blobs.get('objects/00/00/missing')).rejects.toBeInstanceOf(NotFoundError);
    expect(await blobs.has('objects/00/00/missing')).toBe(false);
  });

  it('同じ内容の再書き込みは冪等（エラーにならない）', async () => {
    const blobs = makeStore();
    const key = 'objects/aa/bb/hash';
    const data = encoder.encode('同じ内容');
    await blobs.put(key, data);
    await expect(blobs.put(key, data)).resolves.toBeUndefined();
    expect(new TextDecoder().decode(await blobs.get(key))).toBe('同じ内容');
  });

  it('同じキーに異なる内容を書くと IntegrityError になり、元のデータが残る', async () => {
    const blobs = makeStore();
    const key = 'objects/aa/bb/hash';
    await blobs.put(key, encoder.encode('正しい内容'));

    await expect(blobs.put(key, encoder.encode('改ざんされた内容'))).rejects.toBeInstanceOf(IntegrityError);
    expect(new TextDecoder().decode(await blobs.get(key))).toBe('正しい内容');
  });

  it('list は保存済みキーを辞書順で返し、prefix で絞り込める', async () => {
    const blobs = makeStore();
    await blobs.put('objects/aa/bb/hash1', encoder.encode('1'));
    await blobs.put('objects/cc/dd/hash2', encoder.encode('2'));
    await blobs.put('metadata/ee/ff/hash3', encoder.encode('3'));

    expect(await blobs.list()).toEqual([
      'metadata/ee/ff/hash3',
      'objects/aa/bb/hash1',
      'objects/cc/dd/hash2',
    ]);
    expect(await blobs.list('objects/')).toEqual(['objects/aa/bb/hash1', 'objects/cc/dd/hash2']);
  });

  it('ルートが無い状態の list は空配列を返す', async () => {
    const blobs = makeStore();
    expect(await blobs.list()).toEqual([]);
  });

  it('パストラバーサル（..）を含むキーを拒否する', async () => {
    const blobs = makeStore();
    const data = encoder.encode('x');
    await expect(blobs.put('../逃げる', data)).rejects.toBeInstanceOf(ValidationError);
    await expect(blobs.get('objects/../../etc/passwd')).rejects.toBeInstanceOf(ValidationError);
    await expect(blobs.has('objects/..')).rejects.toBeInstanceOf(ValidationError);
  });

  it('絶対パスをキーとして拒否する', async () => {
    const blobs = makeStore();
    await expect(blobs.put('/tmp/evil', encoder.encode('x'))).rejects.toBeInstanceOf(ValidationError);
    await expect(blobs.get('/etc/hosts')).rejects.toBeInstanceOf(ValidationError);
  });

  it('空キーを拒否する', async () => {
    const blobs = makeStore();
    await expect(blobs.put('', encoder.encode('x'))).rejects.toBeInstanceOf(ValidationError);
  });

  it('書き込み後に一時ファイル（.tmp）が残らない（原子的な rename）', async () => {
    const blobs = makeStore();
    await blobs.put('objects/aa/bb/hash', encoder.encode('data'));
    const files = await readdir(join(root, 'blobs'), { recursive: true });
    expect(files.filter((file) => file.endsWith('.tmp'))).toEqual([]);
  });

  it('reset は保存内容をすべて消してルートを作り直す', async () => {
    const blobs = makeStore();
    await blobs.put('objects/aa/bb/hash', encoder.encode('data'));
    expect(await blobs.list()).toHaveLength(1);

    await blobs.reset();
    expect(await blobs.list()).toEqual([]);
    expect(await blobs.has('objects/aa/bb/hash')).toBe(false);
  });

  it('ファイルシステムのルートを保存先に指定できない', () => {
    expect(() => new LocalBlobStore('/')).toThrow(ValidationError);
  });
});

describe('createArchiveManifest', () => {
  it('空の台帳を決定的に組み立てる', () => {
    const manifest = makeManifest();
    expect(manifest).toEqual({
      schemaVersion: 1,
      archiveId: 'arc-local',
      createdAt: '2026-01-01T09:00:00+09:00',
      retentionYears: 7,
      worm: true,
      entries: [],
      checkpoints: [],
    });
    expect(makeManifest()).toEqual(manifest);
  });

  it('archiveId の前後の空白を除去する', () => {
    expect(makeManifest().archiveId).toBe('arc-local');
    const padded = createArchiveManifest({
      archiveId: '  arc-padded  ',
      createdAt: '2026-01-01T09:00:00+09:00',
      retentionYears: 7,
      worm: false,
    });
    expect(padded.archiveId).toBe('arc-padded');
  });

  it('archiveId・createdAt・retentionYears の不正を拒否する', () => {
    expect(() =>
      createArchiveManifest({ archiveId: '  ', createdAt: '2026-01-01T09:00:00+09:00', retentionYears: 7, worm: false }),
    ).toThrow(ValidationError);
    expect(() =>
      createArchiveManifest({ archiveId: 'arc', createdAt: '2026-01-01', retentionYears: 7, worm: false }),
    ).toThrow(ValidationError);
    expect(() =>
      createArchiveManifest({ archiveId: 'arc', createdAt: '2026-01-01T09:00:00+09:00', retentionYears: 0, worm: false }),
    ).toThrow(ValidationError);
    expect(() =>
      createArchiveManifest({ archiveId: 'arc', createdAt: '2026-01-01T09:00:00+09:00', retentionYears: 7.5, worm: false }),
    ).toThrow(ValidationError);
  });
});

describe('LocalManifestStore', () => {
  /** テスト用の台帳ファイルパス。 */
  function manifestPath(): string {
    return join(root, 'state', 'manifest.json');
  }

  it('ファイルも初期マニフェストも無ければ read は NotFoundError', async () => {
    const store = new LocalManifestStore(manifestPath());
    await expect(store.read()).rejects.toBeInstanceOf(NotFoundError);
  });

  it('ファイルが無く初期マニフェストがあれば、その内容を返す（呼び出し側とは共有しない）', async () => {
    const store = new LocalManifestStore(manifestPath(), { initial: makeManifest() });
    const first = await store.read();
    const second = await store.read();
    expect(first).toEqual(makeManifest());
    expect(second).toEqual(first);
    expect(second).not.toBe(first);
  });

  it('最初の append で台帳ファイルが作られ、JSON として読める', async () => {
    const path = manifestPath();
    const store = new LocalManifestStore(path, { initial: makeManifest() });
    const first = makeEntry(1, GENESIS_PREVIOUS_HASH);
    await store.append(first, { sequence: 0, entryHash: null });

    const manifest = await store.read();
    expect(manifest.entries).toEqual([first]);

    const raw = JSON.parse(await readFile(path, 'utf8')) as ArchiveManifest;
    expect(raw.schemaVersion).toBe(1);
    expect(raw.archiveId).toBe('arc-local');
    expect(raw.entries).toHaveLength(1);
    expect(raw.entries[0]?.entryHash).toBe(first.entryHash);
  });

  it('連番で append でき、都度ファイルが壊れず一時ファイルも残らない', async () => {
    const path = manifestPath();
    const store = new LocalManifestStore(path, { initial: makeManifest() });
    const entries: LedgerEntry[] = [];
    let previousHead: { sequence: number; entryHash: Sha256Hex | null } = { sequence: 0, entryHash: null };
    let previousEntryHash: Sha256Hex = GENESIS_PREVIOUS_HASH;

    for (let sequence = 1; sequence <= 3; sequence += 1) {
      const entry = makeEntry(sequence, previousEntryHash);
      await store.append(entry, previousHead);
      entries.push(entry);
      previousEntryHash = entry.entryHash;
      previousHead = { sequence: entry.sequence, entryHash: entry.entryHash };
      // 追記のたびに JSON として読めることを確認する（半端な書き込みが無い）。
      expect(JSON.parse(await readFile(path, 'utf8')) as ArchiveManifest).toBeDefined();
    }

    const manifest = await store.read();
    expect(manifest.entries.map((entry) => entry.sequence)).toEqual([1, 2, 3]);
    expect(manifest.entries[2]?.entryHash).toBe(entries[2]?.entryHash);

    const files = await readdir(join(root, 'state'), { recursive: true });
    expect(files.filter((file) => file.endsWith('.tmp'))).toEqual([]);
  });

  it('期待した末尾が変わっていれば ChainConflictError（楽観的排他制御）', async () => {
    const store = new LocalManifestStore(manifestPath(), { initial: makeManifest() });
    const first = makeEntry(1, GENESIS_PREVIOUS_HASH);
    await store.append(first, { sequence: 0, entryHash: null });

    const second = makeEntry(2, first.entryHash);
    const error: unknown = await store.append(second, { sequence: 0, entryHash: null }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ChainConflictError);
    if (error instanceof ChainConflictError) {
      expect(error.expectedSequence).toBe(0);
      expect(error.actualSequence).toBe(1);
    }
    // 競合した追記は台帳に反映されない。
    expect((await store.read()).entries).toHaveLength(1);
  });

  it('同じ連番でも末尾ハッシュが違えば ChainConflictError', async () => {
    const store = new LocalManifestStore(manifestPath(), { initial: makeManifest() });
    const first = makeEntry(1, GENESIS_PREVIOUS_HASH);
    await store.append(first, { sequence: 0, entryHash: null });

    await expect(
      store.append(makeEntry(2, first.entryHash), { sequence: 1, entryHash: 'f'.repeat(64) }),
    ).rejects.toBeInstanceOf(ChainConflictError);
  });

  it('連番が飛んだエントリは ValidationError', async () => {
    const store = new LocalManifestStore(manifestPath(), { initial: makeManifest() });
    const first = makeEntry(1, GENESIS_PREVIOUS_HASH);
    await store.append(first, { sequence: 0, entryHash: null });

    await expect(store.append(makeEntry(3, first.entryHash), { sequence: 1, entryHash: first.entryHash })).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect((await store.read()).entries).toHaveLength(1);
  });

  it('直前エントリと連結しない previousEntryHash は ValidationError', async () => {
    const store = new LocalManifestStore(manifestPath(), { initial: makeManifest() });
    const first = makeEntry(1, GENESIS_PREVIOUS_HASH);
    await store.append(first, { sequence: 0, entryHash: null });

    await expect(
      store.append(makeEntry(2, GENESIS_PREVIOUS_HASH), { sequence: 1, entryHash: first.entryHash }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('entryHash が内容と一致しないエントリは ValidationError（壊れた台帳を書かせない）', async () => {
    const store = new LocalManifestStore(manifestPath(), { initial: makeManifest() });
    const first = makeEntry(1, GENESIS_PREVIOUS_HASH);
    await store.append(first, { sequence: 0, entryHash: null });

    const forged: LedgerEntry = { ...makeEntry(2, first.entryHash), entryHash: 'a'.repeat(64) };
    await expect(store.append(forged, { sequence: 1, entryHash: first.entryHash })).rejects.toBeInstanceOf(ValidationError);
  });

  it('updateCheckpoints はチェックポイントを差し替え、エントリは保持する', async () => {
    const path = manifestPath();
    const store = new LocalManifestStore(path, { initial: makeManifest() });
    const first = makeEntry(1, GENESIS_PREVIOUS_HASH);
    await store.append(first, { sequence: 0, entryHash: null });

    const checkpoint = {
      sequence: 1,
      entryHash: first.entryHash,
      recordedAt: '2026-01-15T11:00:00+09:00',
    };
    await store.updateCheckpoints([checkpoint]);

    const manifest = await store.read();
    expect(manifest.checkpoints).toEqual([checkpoint]);
    expect(manifest.entries).toHaveLength(1);
    const raw = JSON.parse(await readFile(path, 'utf8')) as ArchiveManifest;
    expect(raw.checkpoints).toHaveLength(1);
  });

  it('壊れた JSON の台帳は IntegrityError', async () => {
    const path = manifestPath();
    await mkdir(join(root, 'state'), { recursive: true });
    await writeFile(path, '{ これは JSON ではない', 'utf8');
    const store = new LocalManifestStore(path);
    await expect(store.read()).rejects.toBeInstanceOf(IntegrityError);
  });

  it('構造が不正な台帳は IntegrityError', async () => {
    const path = manifestPath();
    await mkdir(join(root, 'state'), { recursive: true });
    await writeFile(path, JSON.stringify({ schemaVersion: 1, archiveId: 'x', entries: 'not-an-array' }), 'utf8');
    const store = new LocalManifestStore(path);
    await expect(store.read()).rejects.toBeInstanceOf(IntegrityError);
  });

  it('別インスタンス（initial なし）からも読める（ファイル永続化）', async () => {
    const path = manifestPath();
    const writer = new LocalManifestStore(path, { initial: makeManifest() });
    const first = makeEntry(1, GENESIS_PREVIOUS_HASH);
    await writer.append(first, { sequence: 0, entryHash: null });

    const reader = new LocalManifestStore(path);
    expect(await reader.read()).toEqual(await writer.read());
  });

  it('改ざんされた台帳（entryHash の書き換え）も read 自体は成功する（検出は verifyLedger の責務）', async () => {
    const path = manifestPath();
    const store = new LocalManifestStore(path, { initial: makeManifest() });
    const first = makeEntry(1, GENESIS_PREVIOUS_HASH);
    await store.append(first, { sequence: 0, entryHash: null });

    const raw = JSON.parse(await readFile(path, 'utf8')) as { entries: Array<Record<string, unknown>> };
    const entry = raw.entries[0];
    if (entry === undefined) {
      throw new Error('フィクスチャのエントリがありません');
    }
    entry['entryHash'] = 'f'.repeat(64);
    await writeFile(path, JSON.stringify(raw), 'utf8');

    const manifest = await store.read();
    expect(manifest.entries[0]?.entryHash).toBe('f'.repeat(64));
  });
});
