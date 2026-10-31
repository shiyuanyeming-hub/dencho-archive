/**
 * ハッシュチェーン（台帳）のテスト。
 *
 * ここでは「実装の写経」ではなく、電帳法の真実性の確保に必要な性質を固定する:
 * - 同じ内容なら必ず同じエントリハッシュになる（決定的）
 * - 保存後に証憑・メタデータ・台帳のどこを 1 バイトでも変えると検出できる
 * - どのフィールドを変えても検出できる（ハッシュ対象の取りこぼしが無い）
 * - 破断は「最初の 1 件」で停止し、位置・理由・期待値・実測値が分かる
 * - 末尾の切捨てはチェックポイントで検出できる
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalBlobStore } from '../../src/adapters/local/blob-store.js';
import { createArchiveManifest } from '../../src/adapters/local/manifest-store.js';
import { canonicalBytes } from '../../src/core/canonical.js';
import {
  GENESIS_PREVIOUS_HASH,
  computeEntryHash,
  createLedgerEntry,
  verifyLedger,
} from '../../src/core/chain.js';
import { ValidationError } from '../../src/core/errors.js';
import {
  ZERO_HASH,
  composeAttestationDigest,
  hashTimestampToken,
  metadataKeyFor,
  objectKeyFor,
  sha256HexBytes,
  sha256HexOf,
} from '../../src/core/hash.js';
import { FixedClock } from '../../src/core/time.js';
import { LocalHmacTimestampAuthority } from '../../src/core/timestamp.js';
import type { ArchiveManifest, LedgerEntry, Sha256Hex, StoredMetadata, TimestampToken, VoucherMetadata } from '../../src/core/types.js';

/** フィクスチャの記録時刻。 */
const RECORDED_AT = '2026-01-15T10:00:00+09:00';

/** フィクスチャの TSA を作る（鍵と時刻を固定して決定的にする）。 */
function makeTsa(id = 'test-tsa', secret = 'test-secret-0123456789'): LocalHmacTimestampAuthority {
  return new LocalHmacTimestampAuthority({ id, secret, clock: new FixedClock(RECORDED_AT) });
}

/** 保存されたメタデータ封筒を読む（テスト用）。 */
function parseEnvelope(bytes: Uint8Array): StoredMetadata {
  return JSON.parse(new TextDecoder().decode(bytes)) as StoredMetadata;
}

/** エントリのメタデータ封筒をブロブストアから読み、テスト用に返す。 */
async function loadEnvelope(blobs: LocalBlobStore, entry: LedgerEntry): Promise<StoredMetadata> {
  return parseEnvelope(await blobs.get(metadataKeyFor(entry.metadataSha256)));
}

/**
 * `count` 件の証憑を保存し、正しく連結された台帳を組み立てる。
 *
 * 本物のブロブストアに本体とメタデータ封筒を保存するので、
 * 検証は実際の I/O を含めて通る。
 */
async function seedArchive(
  blobs: LocalBlobStore,
  count: number,
  tsa: LocalHmacTimestampAuthority = makeTsa(),
): Promise<{ manifest: ArchiveManifest; tsa: LocalHmacTimestampAuthority }> {
  const entries: LedgerEntry[] = [];
  let previousEntryHash = GENESIS_PREVIOUS_HASH;

  for (let sequence = 1; sequence <= count; sequence += 1) {
    const voucherId = `V-${String(sequence).padStart(3, '0')}`;
    const content = new TextEncoder().encode(`証憑データ ${String(sequence)}`);
    const contentSha256 = sha256HexBytes(content);
    const metadata: VoucherMetadata = {
      schemaVersion: 1,
      voucherId,
      transactionDate: '2026-01-15',
      amountYen: sequence * 1_000,
      counterpartyName: '株式会社サンプル商事',
      counterpartyNormalized: 'サンプル商事',
      invoiceRegistrationNumber: null,
      documentType: 'invoice',
      originalFileName: `invoice-${String(sequence)}.pdf`,
      mediaType: 'application/pdf',
      contentSha256,
      contentBytes: content.byteLength,
      receivedAt: '2026-01-15T09:00:00+09:00',
      tags: [],
      note: null,
    };
    const attestationDigest = composeAttestationDigest(contentSha256, sha256HexOf(metadata));
    const timestamp = await tsa.stamp(attestationDigest, new Date(RECORDED_AT));
    const envelope: StoredMetadata = { schemaVersion: 1, metadata, timestamp };
    const envelopeBytes = canonicalBytes(envelope);
    const metadataSha256 = sha256HexBytes(envelopeBytes);

    await blobs.put(objectKeyFor(contentSha256), content);
    await blobs.put(metadataKeyFor(metadataSha256), envelopeBytes);

    const entry = createLedgerEntry({
      sequence,
      voucherId,
      objectKey: objectKeyFor(contentSha256),
      contentSha256,
      metadataSha256,
      timestampSha256: hashTimestampToken(timestamp),
      recordedAt: RECORDED_AT,
      previousEntryHash,
    });
    entries.push(entry);
    previousEntryHash = entry.entryHash;
  }

  const empty = createArchiveManifest({
    archiveId: 'arc-chain-test',
    createdAt: '2026-01-01T09:00:00+09:00',
    retentionYears: 7,
    worm: false,
  });
  return { manifest: { ...empty, entries }, tsa };
}

/** 指定した位置のエントリを取り出す（無ければテスト失敗として投げる）。 */
function entryAt(manifest: ArchiveManifest, index: number): LedgerEntry {
  const entry = manifest.entries[index];
  if (entry === undefined) {
    throw new Error(`フィクスチャのエントリがありません: index=${String(index)}`);
  }
  return entry;
}

/** 検証オプションを組み立てる。 */
function optionsFor(blobs: LocalBlobStore, tsa: LocalHmacTimestampAuthority): {
  blobs: LocalBlobStore;
  verifyTimestamp: (token: TimestampToken, attestationDigest: Sha256Hex) => Promise<boolean>;
} {
  return { blobs, verifyTimestamp: (token, attestationDigest) => tsa.verify(token, attestationDigest) };
}

let root: string;
let blobRoot: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dencho-chain-'));
  blobRoot = join(root, 'blobs');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('GENESIS_PREVIOUS_HASH', () => {
  it('全ゼロ 64 文字で、チェーン先頭のリンク値と一致する', () => {
    expect(GENESIS_PREVIOUS_HASH).toBe(ZERO_HASH);
    expect(GENESIS_PREVIOUS_HASH).toMatch(/^0{64}$/);
  });
});

describe('computeEntryHash', () => {
  /** ハッシュ計算の対象になる全フィールドを持つサンプル。 */
  function sampleEntry(): Omit<LedgerEntry, 'entryHash'> {
    return {
      sequence: 1,
      voucherId: 'V-001',
      objectKey: objectKeyFor(sha256HexOf({ content: 1 })),
      contentSha256: sha256HexOf({ content: 1 }),
      metadataSha256: sha256HexOf({ metadata: 1 }),
      timestampSha256: null,
      recordedAt: RECORDED_AT,
      previousEntryHash: GENESIS_PREVIOUS_HASH,
    };
  }

  it('同じ内容なら何度計算しても同じハッシュになる（決定的）', () => {
    expect(computeEntryHash(sampleEntry())).toBe(computeEntryHash(sampleEntry()));
    expect(computeEntryHash(sampleEntry())).toMatch(/^[0-9a-f]{64}$/);
  });

  it('全フィールドのいずれを変えてもハッシュが変わる（ハッシュ対象の取りこぼしが無い）', () => {
    const base = sampleEntry();
    const baseHash = computeEntryHash(base);
    const mutations: Array<Omit<LedgerEntry, 'entryHash'>> = [
      { ...base, sequence: 2 },
      { ...base, voucherId: 'V-002' },
      { ...base, objectKey: objectKeyFor(sha256HexOf({ content: 2 })) },
      { ...base, contentSha256: sha256HexOf({ content: 2 }) },
      { ...base, metadataSha256: sha256HexOf({ metadata: 2 }) },
      { ...base, timestampSha256: sha256HexOf({ timestamp: 1 }) },
      { ...base, recordedAt: '2026-01-16T10:00:00+09:00' },
      { ...base, previousEntryHash: sha256HexOf({ previous: 1 }) },
    ];
    const hashes = new Set(mutations.map((mutated) => computeEntryHash(mutated)));
    expect(hashes.size).toBe(mutations.length);
    expect(hashes.has(baseHash)).toBe(false);
  });
});

describe('createLedgerEntry', () => {
  function sampleInput(): {
    sequence: number;
    voucherId: string;
    objectKey: string;
    contentSha256: Sha256Hex;
    metadataSha256: Sha256Hex;
    timestampSha256: Sha256Hex | null;
    recordedAt: string;
    previousEntryHash: Sha256Hex;
  } {
    return {
      sequence: 1,
      voucherId: 'V-001',
      objectKey: objectKeyFor(sha256HexOf({ content: 1 })),
      contentSha256: sha256HexOf({ content: 1 }),
      metadataSha256: sha256HexOf({ metadata: 1 }),
      timestampSha256: null,
      recordedAt: RECORDED_AT,
      previousEntryHash: GENESIS_PREVIOUS_HASH,
    };
  }

  it('entryHash を計算し、入力フィールドをそのまま保持する', () => {
    const input = sampleInput();
    const entry = createLedgerEntry(input);
    expect(entry.entryHash).toBe(computeEntryHash(input));
    const { entryHash: _entryHash, ...rest } = entry;
    expect(rest).toEqual(input);
  });

  it('タイムスタンプ未付与（null）のエントリも組み立てられる', () => {
    const entry = createLedgerEntry({ ...sampleInput(), timestampSha256: null });
    expect(entry.timestampSha256).toBeNull();
    expect(entry.entryHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('第 1 項の previousEntryHash が全ゼロでなければ拒否する（先頭の偽装防止）', () => {
    expect(() =>
      createLedgerEntry({ ...sampleInput(), previousEntryHash: sha256HexOf({ previous: 1 }) }),
    ).toThrow(ValidationError);
  });

  it('連番・識別子・ハッシュ・記録時刻の不正を拒否する', () => {
    expect(() => createLedgerEntry({ ...sampleInput(), sequence: 0 })).toThrow(ValidationError);
    expect(() => createLedgerEntry({ ...sampleInput(), sequence: 1.5 })).toThrow(ValidationError);
    expect(() => createLedgerEntry({ ...sampleInput(), voucherId: '   ' })).toThrow(ValidationError);
    expect(() => createLedgerEntry({ ...sampleInput(), objectKey: '' })).toThrow(ValidationError);
    expect(() => createLedgerEntry({ ...sampleInput(), contentSha256: 'xyz' })).toThrow(ValidationError);
    expect(() => createLedgerEntry({ ...sampleInput(), metadataSha256: 'abc' })).toThrow(ValidationError);
    expect(() => createLedgerEntry({ ...sampleInput(), timestampSha256: 'not-a-hash' })).toThrow(ValidationError);
    expect(() => createLedgerEntry({ ...sampleInput(), recordedAt: '2026-01-15' })).toThrow(ValidationError);
    expect(() => createLedgerEntry({ ...sampleInput(), previousEntryHash: 'short' })).toThrow(ValidationError);
  });
});

describe('verifyLedger（正常系）', () => {
  it('空の台帳は empty を返す', async () => {
    const blobs = new LocalBlobStore(blobRoot);
    const manifest = createArchiveManifest({
      archiveId: 'arc-empty',
      createdAt: '2026-01-01T09:00:00+09:00',
      retentionYears: 7,
      worm: true,
    });
    const result = await verifyLedger(manifest, { blobs });
    expect(result).toEqual({ status: 'empty', checkedEntries: 0, headHash: null, checkpointsVerified: true });
  });

  it('正しい台帳は intact を返し、headHash は末尾エントリのハッシュになる', async () => {
    const blobs = new LocalBlobStore(blobRoot);
    const { manifest, tsa } = await seedArchive(blobs, 3);
    const result = await verifyLedger(manifest, optionsFor(blobs, tsa));
    expect(result.status).toBe('intact');
    expect(result.checkedEntries).toBe(3);
    expect(result.break).toBeUndefined();
    expect(result.checkpointsVerified).toBe(true);
    expect(result.headHash).toBe(entryAt(manifest, 2).entryHash);
  });

  it('verifyTimestamp を省略してもハッシュチェーンは検証する', async () => {
    const blobs = new LocalBlobStore(blobRoot);
    const { manifest } = await seedArchive(blobs, 2);
    const result = await verifyLedger(manifest, { blobs });
    expect(result.status).toBe('intact');
    expect(result.checkedEntries).toBe(2);
  });

  it('同じ台帳を 2 回検証すると同じ結果になる（決定的）', async () => {
    const blobs = new LocalBlobStore(blobRoot);
    const { manifest, tsa } = await seedArchive(blobs, 2);
    const options = optionsFor(blobs, tsa);
    const first = await verifyLedger(manifest, options);
    const second = await verifyLedger(manifest, options);
    expect(second).toEqual(first);
  });

  it('タイムスタンプの検証対象は「本体 + タイムスタンプを含まないメタデータ」のダイジェスト', async () => {
    const blobs = new LocalBlobStore(blobRoot);
    const { manifest, tsa } = await seedArchive(blobs, 1);
    const entry = entryAt(manifest, 0);
    const envelope = await loadEnvelope(blobs, entry);
    const digests: Sha256Hex[] = [];
    const result = await verifyLedger(manifest, {
      blobs,
      verifyTimestamp: (token, attestationDigest) => {
        digests.push(attestationDigest);
        return tsa.verify(token, attestationDigest);
      },
    });
    expect(result.status).toBe('intact');
    expect(digests).toEqual([composeAttestationDigest(entry.contentSha256, sha256HexOf(envelope.metadata))]);
  });
});

describe('verifyLedger（改ざん検出）', () => {
  it('証憑データを書き換えると content-mismatch（位置・期待値・実測値つき）', async () => {
    const blobs = new LocalBlobStore(blobRoot);
    const { manifest, tsa } = await seedArchive(blobs, 3);
    const target = entryAt(manifest, 1);
    const tampered = new TextEncoder().encode('改ざんされた証憑データ');
    await writeFile(join(blobRoot, objectKeyFor(target.contentSha256)), tampered);

    const result = await verifyLedger(manifest, optionsFor(blobs, tsa));
    expect(result.status).toBe('broken');
    expect(result.break?.reason).toBe('content-mismatch');
    expect(result.break?.sequence).toBe(2);
    expect(result.break?.voucherId).toBe('V-002');
    expect(result.break?.expected).toBe(target.contentSha256);
    expect(result.break?.actual).toBe(sha256HexBytes(tampered));
    expect(result.checkedEntries).toBe(1);
    // 破断していても台帳自体の末尾ハッシュは報告する（監査記録用）。
    expect(result.headHash).toBe(entryAt(manifest, 2).entryHash);
  });

  it('メタデータを書き換えると metadata-mismatch', async () => {
    const blobs = new LocalBlobStore(blobRoot);
    const { manifest, tsa } = await seedArchive(blobs, 3);
    const target = entryAt(manifest, 2);
    const tampered = new TextEncoder().encode('{"schemaVersion":1,"metadata":{},"timestamp":null}');
    await writeFile(join(blobRoot, metadataKeyFor(target.metadataSha256)), tampered);

    const result = await verifyLedger(manifest, optionsFor(blobs, tsa));
    expect(result.break?.reason).toBe('metadata-mismatch');
    expect(result.break?.sequence).toBe(3);
    expect(result.break?.expected).toBe(target.metadataSha256);
    expect(result.break?.actual).toBe(sha256HexBytes(tampered));
  });

  it('途中のエントリを削除すると chain-link-mismatch（次のエントリで検出）', async () => {
    const blobs = new LocalBlobStore(blobRoot);
    const { manifest, tsa } = await seedArchive(blobs, 3);
    const withoutSecond: ArchiveManifest = {
      ...manifest,
      entries: manifest.entries.filter((_entry, index) => index !== 1),
    };

    const result = await verifyLedger(withoutSecond, optionsFor(blobs, tsa));
    expect(result.break?.reason).toBe('chain-link-mismatch');
    expect(result.break?.sequence).toBe(3);
    expect(result.break?.voucherId).toBe('V-003');
    expect(result.break?.expected).toBe(entryAt(manifest, 0).entryHash);
    expect(result.break?.actual).toBe(entryAt(manifest, 2).previousEntryHash);
    expect(result.checkedEntries).toBe(1);
  });

  it('先頭のエントリを削除すると chain-link-mismatch（2 番目が先頭の連結値を持たない）', async () => {
    const blobs = new LocalBlobStore(blobRoot);
    const { manifest, tsa } = await seedArchive(blobs, 2);
    const withoutFirst: ArchiveManifest = { ...manifest, entries: manifest.entries.slice(1) };

    const result = await verifyLedger(withoutFirst, optionsFor(blobs, tsa));
    expect(result.break?.reason).toBe('chain-link-mismatch');
    expect(result.break?.sequence).toBe(2);
    expect(result.break?.expected).toBe(GENESIS_PREVIOUS_HASH);
    expect(result.break?.actual).toBe(entryAt(manifest, 1).previousEntryHash);
    expect(result.checkedEntries).toBe(0);
  });

  it('entryHash を書き換えると entry-hash-mismatch', async () => {
    const blobs = new LocalBlobStore(blobRoot);
    const { manifest, tsa } = await seedArchive(blobs, 3);
    const tamperedHash = 'f'.repeat(64);
    const tampered: ArchiveManifest = {
      ...manifest,
      entries: manifest.entries.map((entry, index) =>
        index === 1 ? { ...entry, entryHash: tamperedHash } : entry,
      ),
    };

    const result = await verifyLedger(tampered, optionsFor(blobs, tsa));
    expect(result.break?.reason).toBe('entry-hash-mismatch');
    expect(result.break?.sequence).toBe(2);
    expect(result.break?.expected).toBe(entryAt(manifest, 1).entryHash);
    expect(result.break?.actual).toBe(tamperedHash);
  });

  it('証憑データのオブジェクトを消すと object-missing', async () => {
    const blobs = new LocalBlobStore(blobRoot);
    const { manifest, tsa } = await seedArchive(blobs, 2);
    const target = entryAt(manifest, 0);
    const key = objectKeyFor(target.contentSha256);
    await rm(join(blobRoot, key), { force: true });

    const result = await verifyLedger(manifest, optionsFor(blobs, tsa));
    expect(result.break?.reason).toBe('object-missing');
    expect(result.break?.sequence).toBe(1);
    expect(result.break?.expected).toBe(key);
    expect(result.break?.actual).toBe('missing');
  });

  it('メタデータのオブジェクトを消すと object-missing', async () => {
    const blobs = new LocalBlobStore(blobRoot);
    const { manifest, tsa } = await seedArchive(blobs, 2);
    const target = entryAt(manifest, 1);
    const key = metadataKeyFor(target.metadataSha256);
    await rm(join(blobRoot, key), { force: true });

    const result = await verifyLedger(manifest, optionsFor(blobs, tsa));
    expect(result.break?.reason).toBe('object-missing');
    expect(result.break?.sequence).toBe(2);
    expect(result.break?.expected).toBe(key);
  });

  it('封筒内のタイムスタンプだけが台帳のハッシュと食い違うと timestamp-mismatch', async () => {
    const blobs = new LocalBlobStore(blobRoot);
    const { manifest, tsa } = await seedArchive(blobs, 1);
    const original = entryAt(manifest, 0);
    // タイムスタンプを「未付与」と記録したエントリを組み立てる（封筒にはトークンが残る）。
    const forged = createLedgerEntry({
      sequence: 1,
      voucherId: original.voucherId,
      objectKey: original.objectKey,
      contentSha256: original.contentSha256,
      metadataSha256: original.metadataSha256,
      timestampSha256: null,
      recordedAt: original.recordedAt,
      previousEntryHash: GENESIS_PREVIOUS_HASH,
    });
    const forgedManifest: ArchiveManifest = { ...manifest, entries: [forged] };
    const envelope = await loadEnvelope(blobs, original);

    const result = await verifyLedger(forgedManifest, optionsFor(blobs, tsa));
    expect(result.break?.reason).toBe('timestamp-mismatch');
    expect(result.break?.expected).toBe('null');
    expect(result.break?.actual).toBe(hashTimestampToken(envelope.timestamp));
  });

  it('複数箇所が壊れていても最初に壊れたエントリで停止する', async () => {
    const blobs = new LocalBlobStore(blobRoot);
    const { manifest, tsa } = await seedArchive(blobs, 3);
    // 1 件目の証憑データを改ざん。
    await writeFile(
      join(blobRoot, objectKeyFor(entryAt(manifest, 0).contentSha256)),
      new TextEncoder().encode('改ざん 1'),
    );
    // 2 件目の entryHash も改ざん。
    const tampered: ArchiveManifest = {
      ...manifest,
      entries: manifest.entries.map((entry, index) =>
        index === 1 ? { ...entry, entryHash: 'e'.repeat(64) } : entry,
      ),
    };

    const result = await verifyLedger(tampered, optionsFor(blobs, tsa));
    expect(result.break?.sequence).toBe(1);
    expect(result.break?.reason).toBe('content-mismatch');
  });
});

describe('verifyLedger（タイムスタンプ検証）', () => {
  it('TSA の検証に失敗すると timestamp-mismatch（署名・鍵が違う等）', async () => {
    const blobs = new LocalBlobStore(blobRoot);
    const { manifest, tsa } = await seedArchive(blobs, 2);
    const entry = entryAt(manifest, 0);
    const envelope = await loadEnvelope(blobs, entry);
    const otherTsa = makeTsa('other-tsa', 'other-secret-0123456789');
    const token = envelope.timestamp;
    if (token === null) {
      throw new Error('フィクスチャのタイムスタンプがありません');
    }

    const result = await verifyLedger(manifest, {
      blobs,
      verifyTimestamp: (candidate, digest) => otherTsa.verify(candidate, digest),
    });
    expect(result.break?.reason).toBe('timestamp-mismatch');
    expect(result.break?.sequence).toBe(1);
    expect(result.break?.expected).toBe(
      composeAttestationDigest(entry.contentSha256, sha256HexOf(envelope.metadata)),
    );
    expect(result.break?.actual).toBe(token.digest);
    // 正しい TSA なら通る（テスト自体の健全性）。
    expect((await verifyLedger(manifest, optionsFor(blobs, tsa))).status).toBe('intact');
  });

  it('検証関数が例外を投げても検証全体を落とさず timestamp-mismatch として報告する', async () => {
    const blobs = new LocalBlobStore(blobRoot);
    const { manifest } = await seedArchive(blobs, 1);
    const result = await verifyLedger(manifest, {
      blobs,
      verifyTimestamp: async () => {
        throw new Error('TSA に接続できません');
      },
    });
    expect(result.status).toBe('broken');
    expect(result.break?.reason).toBe('timestamp-mismatch');
  });
});

describe('verifyLedger（チェックポイント）', () => {
  it('正しいチェックポイントは checkpointsVerified = true', async () => {
    const blobs = new LocalBlobStore(blobRoot);
    const { manifest, tsa } = await seedArchive(blobs, 3);
    const withCheckpoints: ArchiveManifest = {
      ...manifest,
      checkpoints: [
        { sequence: 1, entryHash: entryAt(manifest, 0).entryHash, recordedAt: RECORDED_AT },
        { sequence: 3, entryHash: entryAt(manifest, 2).entryHash, recordedAt: RECORDED_AT },
      ],
    };
    const result = await verifyLedger(withCheckpoints, optionsFor(blobs, tsa));
    expect(result.status).toBe('intact');
    expect(result.checkpointsVerified).toBe(true);
  });

  it('末尾が差し替わっていると checkpointsVerified = false（チェーン連結だけでは検出できない切捨て）', async () => {
    const blobs = new LocalBlobStore(blobRoot);
    const { manifest, tsa } = await seedArchive(blobs, 3);
    const withBadCheckpoint: ArchiveManifest = {
      ...manifest,
      checkpoints: [{ sequence: 3, entryHash: 'a'.repeat(64), recordedAt: RECORDED_AT }],
    };
    const result = await verifyLedger(withBadCheckpoint, optionsFor(blobs, tsa));
    expect(result.status).toBe('intact');
    expect(result.checkpointsVerified).toBe(false);
  });

  it('存在しない位置のチェックポイントは checkpointsVerified = false', async () => {
    const blobs = new LocalBlobStore(blobRoot);
    const { manifest, tsa } = await seedArchive(blobs, 2);
    const withFutureCheckpoint: ArchiveManifest = {
      ...manifest,
      checkpoints: [{ sequence: 99, entryHash: 'b'.repeat(64), recordedAt: RECORDED_AT }],
    };
    const result = await verifyLedger(withFutureCheckpoint, optionsFor(blobs, tsa));
    expect(result.checkpointsVerified).toBe(false);
  });
});
