/**
 * 追記専用台帳（ハッシュチェーン）の計算と検証。
 *
 * 電帳法の「真実性の確保」では、証憑データが保存後に改ざん・削除されていない
 * ことを証明できる必要がある。本モジュールは、各台帳エントリを
 * 「証憑本体のハッシュ + メタデータのハッシュ + タイムスタンプのハッシュ +
 * 直前エントリのハッシュ」の SHA-256 で連結し、1 件でも改ざん・削除・
 * 並べ替えがあれば検証で検出できるようにする。
 *
 * 設計方針:
 * - ハッシュ対象は `core/canonical.ts` で正規化した JSON から計算する。
 *   キー順や空白に依存させない（同じ内容なら必ず同じハッシュ）。
 * - `entryHash` は自分自身を除く全フィールドから計算する。したがって
 *   `entryHash` だけを書き換えても、また任意のフィールドを書き換えても
 *   再計算値と一致しなくなる。
 * - 検証は「最初に壊れた箇所で停止」する。すべての破損を列挙するのではなく、
 *   最初の破断を返すことで、どの時点から信頼できないかを明確にする。
 * - チェックポイント（台帳末尾のハッシュの控え）は、末尾の切捨てを検出する。
 *   チェーンの連結だけでは「最後の数件を削除した」ことを検出できないため。
 * - タイムスタンプの検証（TSA への問い合わせ）は I/O を含むため注入する。
 */
import { NotFoundError, ValidationError } from './errors.js';
import {
  ZERO_HASH,
  composeAttestationDigest,
  hashesEqual,
  hashTimestampToken,
  isSha256Hex,
  metadataKeyFor,
  objectKeyFor,
  sha256HexBytes,
  sha256HexOf,
} from './hash.js';
import { isValidIsoInstant } from './time.js';
import type {
  ArchiveManifest,
  BlobStore,
  ChainBreakReason,
  ChainVerification,
  IsoInstant,
  LedgerEntry,
  Sha256Hex,
  TimestampToken,
} from './types.js';

/**
 * チェーン先頭（第 1 項）の `previousEntryHash` に使う全ゼロハッシュ。
 *
 * 台帳の最初のエントリだけがこの値を持ち、2 件目以降は直前エントリの
 * `entryHash` を持つ。この規約により「先頭が欠けている」ことも検出できる。
 */
export const GENESIS_PREVIOUS_HASH: Sha256Hex = ZERO_HASH;

/**
 * 台帳へ追記する 1 件分の入力。
 *
 * `entryHash` を除く `LedgerEntry` の全フィールドを持つ。`entryHash` は
 * これらの内容から計算するため、呼び出し側が指定することはできない。
 */
export interface EntryInput {
  /** 1 始まりの通し番号。 */
  readonly sequence: number;
  /** 証憑の一意な識別子。 */
  readonly voucherId: string;
  /** 証憑データ本体の保存キー（内容アドレス）。 */
  readonly objectKey: string;
  /** 証憑データ本体の SHA-256。 */
  readonly contentSha256: Sha256Hex;
  /** メタデータ封筒の SHA-256。 */
  readonly metadataSha256: Sha256Hex;
  /** タイムスタンプトークンの SHA-256（未付与なら null）。 */
  readonly timestampSha256: Sha256Hex | null;
  /** 台帳への記録時刻（オフセット付き RFC3339）。 */
  readonly recordedAt: IsoInstant;
  /** 直前エントリの `entryHash`（先頭は `GENESIS_PREVIOUS_HASH`）。 */
  readonly previousEntryHash: Sha256Hex;
}

/**
 * 台帳から 1 件分のエントリハッシュを計算する。
 *
 * `entryHash` を除く全フィールドを正規化 JSON にして SHA-256 を取る。
 * 同じ内容なら何度計算しても同じ値になり、1 フィールドでも変われば
 * 別の値になる。
 *
 * @param entry ハッシュ対象のエントリ（`entryHash` は含めない）。
 * @returns 64 文字の SHA-256（小文字 16 進）。
 */
export function computeEntryHash(entry: Omit<LedgerEntry, 'entryHash'>): Sha256Hex {
  return sha256HexOf({
    sequence: entry.sequence,
    voucherId: entry.voucherId,
    objectKey: entry.objectKey,
    contentSha256: entry.contentSha256,
    metadataSha256: entry.metadataSha256,
    timestampSha256: entry.timestampSha256,
    recordedAt: entry.recordedAt,
    previousEntryHash: entry.previousEntryHash,
  });
}

/**
 * 追記する台帳エントリを組み立て、`entryHash` を計算して返す。
 *
 * 「エントリを作る」処理を 1 か所に集約することで、ハッシュ計算の
 * 取りこぼし（フィールド追加時に計算対象から漏れる等）を防ぐ。
 *
 * @throws ValidationError 連番・ハッシュ・記録時刻・先頭エントリの連結規約が不正な場合。
 */
export function createLedgerEntry(input: EntryInput): LedgerEntry {
  validateEntryInput(input);
  const withoutHash: Omit<LedgerEntry, 'entryHash'> = {
    sequence: input.sequence,
    voucherId: input.voucherId,
    objectKey: input.objectKey,
    contentSha256: input.contentSha256,
    metadataSha256: input.metadataSha256,
    timestampSha256: input.timestampSha256,
    recordedAt: input.recordedAt,
    previousEntryHash: input.previousEntryHash,
  };
  return { ...withoutHash, entryHash: computeEntryHash(withoutHash) };
}

/**
 * `verifyLedger` の依存。
 *
 * 検証には保存済みオブジェクトの読み出しが必要なので、ストアは注入する。
 */
export interface VerifyLedgerOptions {
  /** 証憑データ本体とメタデータ封筒の保存先。 */
  readonly blobs: BlobStore;
  /**
   * タイムスタンプトークンの検証関数（省略時はトークンの存在とハッシュのみ確認）。
   *
   * `attestationDigest` は、証憑本体と（タイムスタンプを含まない）メタデータの
   * 両方に結びついたダイジェストである。TSA（時刻認証局）の公開鍵検証を
   * 注入することで、コアは AWS にもローカル実装にも依存しない。
   */
  readonly verifyTimestamp?: (token: TimestampToken, attestationDigest: Sha256Hex) => Promise<boolean>;
}

/**
 * 台帳全体を検証し、最初の破断を返す。
 *
 * 検査順序（最初に失敗した時点で停止する）:
 * 1. チェーンリンク: `previousEntryHash` が直前エントリの `entryHash` と一致するか
 *    （第 1 項は `GENESIS_PREVIOUS_HASH`）。あわせて連番が 1 から連続しているか。
 * 2. エントリハッシュ: 内容から再計算した値が保存された `entryHash` と一致するか。
 * 3. 証憑本体: 保存されたオブジェクトの SHA-256 が `contentSha256` と一致するか。
 * 4. メタデータ封筒: 保存されたオブジェクトの SHA-256 が `metadataSha256` と
 *    一致するか。さらに封筒内のタイムスタンプのハッシュが `timestampSha256` と
 *    一致するか。
 * 5. タイムスタンプ: `verifyTimestamp` が指定されていれば、トークンが
 *    証憑本体とメタデータに結びついたダイジェストに対して正当か。
 *
 * チェックポイントの照合は破断の有無に関わらず全件行う。チェーンの連結だけでは
 * 末尾の切捨てを検出できないため、`checkpointsVerified` を別途返す。
 *
 * 空の台帳は `status: 'empty'` を返し、チェックポイントも整合とみなす。
 *
 * @param manifest 検証対象の台帳。
 * @param options 保存先ストアとタイムスタンプ検証関数。
 * @returns 検証結果。破断があれば `break` に最初の 1 件を含む。
 */
export async function verifyLedger(
  manifest: ArchiveManifest,
  options: VerifyLedgerOptions,
): Promise<ChainVerification> {
  const entries = manifest.entries;

  // 空の台帳には検証対象が無い。チェックポイントの有無に関わらず整合とみなす。
  if (entries.length === 0) {
    return { status: 'empty', checkedEntries: 0, headHash: null, checkpointsVerified: true };
  }

  // 「head」は追記点である末尾エントリのハッシュを指す（`ManifestStore.append` の
  // `expectHead` と同じ意味）。次の追記が連結すべき値であり、台帳の現在の姿を
  // 1 つの値で代表する。
  const headHash: Sha256Hex = entries[entries.length - 1]?.entryHash ?? ZERO_HASH;
  const checkpointsVerified = verifyCheckpoints(manifest);

  const broken = (
    index: number,
    entry: LedgerEntry,
    reason: ChainBreakReason,
    expected: string,
    actual: string,
  ): ChainVerification => ({
    status: 'broken',
    checkedEntries: index,
    headHash,
    checkpointsVerified,
    break: {
      sequence: entry.sequence,
      reason,
      expected,
      actual,
      voucherId: entry.voucherId,
    },
  });

  let previousEntry: LedgerEntry | null = null;

  for (const [index, entry] of entries.entries()) {
    // 1. チェーンリンク: 直前エントリのハッシュと繋がっているか。
    const expectedPreviousHash = previousEntry === null ? GENESIS_PREVIOUS_HASH : previousEntry.entryHash;
    if (!hashesEqual(entry.previousEntryHash, expectedPreviousHash)) {
      return broken(index, entry, 'chain-link-mismatch', expectedPreviousHash, entry.previousEntryHash);
    }
    // 1b. 連番の連続性: 削除・並べ替えで番号が飛んでいないか。
    const expectedSequence = previousEntry === null ? 1 : previousEntry.sequence + 1;
    if (entry.sequence !== expectedSequence) {
      return broken(index, entry, 'chain-link-mismatch', String(expectedSequence), String(entry.sequence));
    }

    // 2. エントリハッシュ: 内容と保存されたハッシュが一致するか。
    const recomputedEntryHash = computeEntryHash(entry);
    if (!hashesEqual(recomputedEntryHash, entry.entryHash)) {
      return broken(index, entry, 'entry-hash-mismatch', recomputedEntryHash, entry.entryHash);
    }

    // 3. 証憑データ本体: 内容アドレスのオブジェクトが存在し、ハッシュが一致するか。
    const contentKey = objectKeyFor(entry.contentSha256);
    const contentBytes = await readBlobIfPresent(options.blobs, contentKey);
    if (contentBytes === null) {
      return broken(index, entry, 'object-missing', contentKey, 'missing');
    }
    const actualContentSha256 = sha256HexBytes(contentBytes);
    if (!hashesEqual(actualContentSha256, entry.contentSha256)) {
      return broken(index, entry, 'content-mismatch', entry.contentSha256, actualContentSha256);
    }

    // 4. メタデータ封筒: オブジェクトのハッシュと、封筒内タイムスタンプのハッシュ。
    const metadataKey = metadataKeyFor(entry.metadataSha256);
    const metadataBytes = await readBlobIfPresent(options.blobs, metadataKey);
    if (metadataBytes === null) {
      return broken(index, entry, 'object-missing', metadataKey, 'missing');
    }
    const actualMetadataSha256 = sha256HexBytes(metadataBytes);
    if (!hashesEqual(actualMetadataSha256, entry.metadataSha256)) {
      return broken(index, entry, 'metadata-mismatch', entry.metadataSha256, actualMetadataSha256);
    }
    const envelope = parseStoredEnvelope(metadataBytes);
    if (envelope === null) {
      return broken(index, entry, 'metadata-mismatch', entry.metadataSha256, 'invalid-envelope');
    }
    const actualTimestampSha256 = hashTimestampToken(envelope.timestamp);
    if (!optionalHashesEqual(actualTimestampSha256, entry.timestampSha256)) {
      return broken(
        index,
        entry,
        'timestamp-mismatch',
        entry.timestampSha256 ?? 'null',
        actualTimestampSha256 ?? 'null',
      );
    }

    // 5. タイムスタンプトークンの検証（TSA の署名検証）。
    if (options.verifyTimestamp !== undefined && envelope.timestamp !== null) {
      // 証明対象は「証憑本体のハッシュ + タイムスタンプを含まないメタデータのハッシュ」。
      // 封筒全体（タイムスタンプを含む）のハッシュを証明対象にすると、
      // トークン生成前にダイジェストを確定できず循環するため、ここでは
      // 封筒内のメタデータから再計算する（Archive.ingest と同じ規則）。
      const attestationDigest = composeAttestationDigest(entry.contentSha256, sha256HexOf(envelope.metadata));
      const verified = await isTimestampVerified(options.verifyTimestamp, envelope.timestamp, attestationDigest);
      if (!verified) {
        return broken(index, entry, 'timestamp-mismatch', attestationDigest, envelope.timestamp.digest);
      }
    }

    previousEntry = entry;
  }

  return { status: 'intact', checkedEntries: entries.length, headHash, checkpointsVerified };
}

// ---------------------------------------------------------------------------
// 内部ヘルパー
// ---------------------------------------------------------------------------

/** `VerifyLedgerOptions.verifyTimestamp` と同じ形の検証関数。 */
type TimestampVerifier = NonNullable<VerifyLedgerOptions['verifyTimestamp']>;

/** タイムスタンプ検証の失敗（例外を含む）を「不正」として扱う。 */
async function isTimestampVerified(
  verifier: TimestampVerifier,
  token: TimestampToken,
  attestationDigest: Sha256Hex,
): Promise<boolean> {
  try {
    return await verifier(token, attestationDigest);
  } catch {
    // 改ざんされたトークンで検証器が例外を投げても、検証結果は「失敗」であり
    // 監査を落とすべきではない（検証できなかったことを破断として報告する）。
    return false;
  }
}

/** メタデータ封筒から、検証に必要な部分だけを取り出した結果。 */
interface ParsedEnvelope {
  /** タイムスタンプを含まないメタデータ本体（ダイジェスト再計算に使う）。 */
  readonly metadata: unknown;
  /** タイムスタンプトークン（未付与なら null）。 */
  readonly timestamp: TimestampToken | null;
}

/**
 * メタデータ封筒（`StoredMetadata`）を解析する。
 *
 * ハッシュの一致は呼び出し側で確認済みのため、ここでは検証に使う形かだけを
 * 確認する。JSON として壊れている場合やエンベロープでない場合は null。
 */
function parseStoredEnvelope(bytes: Uint8Array): ParsedEnvelope | null {
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return null;
  }
  const record = raw as Readonly<Record<string, unknown>>;
  if (record['schemaVersion'] !== 1) {
    return null;
  }
  const metadata = record['metadata'];
  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) {
    return null;
  }
  const rawTimestamp = record['timestamp'];
  if (rawTimestamp === null) {
    return { metadata, timestamp: null };
  }
  if (typeof rawTimestamp !== 'object' || Array.isArray(rawTimestamp)) {
    return null;
  }
  // トークンの各フィールドの妥当性は TSA の検証関数が判断する。
  return { metadata, timestamp: rawTimestamp as TimestampToken };
}

/**
 * チェックポイントがすべて台帳と整合するかを返す。
 *
 * チェックポイントは「その時点で末尾だったエントリのハッシュ」を控えたもの。
 * すべて一致すれば、末尾の切捨てや差し替えが起きていないと判断できる。
 */
function verifyCheckpoints(manifest: ArchiveManifest): boolean {
  for (const checkpoint of manifest.checkpoints) {
    const entry = manifest.entries[checkpoint.sequence - 1];
    if (entry === undefined) {
      return false;
    }
    if (!hashesEqual(entry.entryHash, checkpoint.entryHash)) {
      return false;
    }
  }
  return true;
}

/** ブロブを読み出す。存在しなければ null（破断理由を object-missing にするため）。 */
async function readBlobIfPresent(blobs: BlobStore, key: string): Promise<Uint8Array | null> {
  if (!(await blobs.has(key))) {
    return null;
  }
  try {
    return await blobs.get(key);
  } catch (error) {
    // has() と get() の間に消えた場合だけを missing 扱いにする。
    if (error instanceof NotFoundError) {
      return null;
    }
    throw error;
  }
}

/** `null` を許すハッシュ同士の比較（未付与のタイムスタンプを正しく同値扱いする）。 */
function optionalHashesEqual(left: Sha256Hex | null, right: Sha256Hex | null): boolean {
  if (left === null || right === null) {
    return left === right;
  }
  return hashesEqual(left, right);
}

/** エントリ入力の型・値の検証。 */
function validateEntryInput(input: EntryInput): void {
  if (!Number.isInteger(input.sequence) || input.sequence < 1) {
    throw new ValidationError('sequence は 1 以上の整数で指定してください', { sequence: input.sequence });
  }
  if (typeof input.voucherId !== 'string' || input.voucherId.trim().length === 0) {
    throw new ValidationError('voucherId は必須です');
  }
  if (typeof input.objectKey !== 'string' || input.objectKey.trim().length === 0) {
    throw new ValidationError('objectKey は必須です');
  }
  assertSha256(input.contentSha256, 'contentSha256');
  assertSha256(input.metadataSha256, 'metadataSha256');
  if (input.timestampSha256 !== null) {
    assertSha256(input.timestampSha256, 'timestampSha256');
  }
  if (!isValidIsoInstant(input.recordedAt)) {
    throw new ValidationError(
      'recordedAt はオフセット付き RFC3339（例: 2026-10-31T18:30:00+09:00）で指定してください',
      { recordedAt: input.recordedAt },
    );
  }
  assertSha256(input.previousEntryHash, 'previousEntryHash');
  if (input.sequence === 1 && input.previousEntryHash !== GENESIS_PREVIOUS_HASH) {
    throw new ValidationError('第 1 項の previousEntryHash は GENESIS_PREVIOUS_HASH（全ゼロ）でなければなりません', {
      previousEntryHash: input.previousEntryHash,
    });
  }
}

/** SHA-256 の 16 進 64 文字であることを要求する。 */
function assertSha256(value: string, field: string): void {
  if (typeof value !== 'string' || !isSha256Hex(value)) {
    throw new ValidationError(`${field} は SHA-256 の小文字 16 進 64 文字で指定してください`, { [field]: value });
  }
}
