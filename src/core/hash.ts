/**
 * ハッシュ計算。
 *
 * すべてのダイジェストは SHA-256 の小文字 16 進 64 文字で扱う。
 * 「どの値をハッシュしたか」が検証の要になるため、ハッシュ対象は
 * 必ず正規化（`canonical.ts`）してから渡す。
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import type { Sha256Hex } from './types.js';
import { canonicalBytes } from './canonical.js';

/** チェーン先頭の `previousEntryHash` に使う全ゼロ。 */
export const ZERO_HASH: Sha256Hex = '0'.repeat(64);

/** バイト列の SHA-256。 */
export function sha256HexBytes(data: Uint8Array): Sha256Hex {
  return createHash('sha256').update(data).digest('hex');
}

/** 文字列（UTF-8）の SHA-256。 */
export function sha256HexText(text: string): Sha256Hex {
  return sha256HexBytes(new TextEncoder().encode(text));
}

/** 任意の値を正規化してハッシュする。 */
export function sha256HexOf(value: unknown): Sha256Hex {
  return sha256HexBytes(canonicalBytes(value));
}

/**
 * タイムスタンプが対象とするダイジェスト。
 *
 * 証憑データ本体とメタデータの両方に結びつけることで、
 * 「本体だけ差し替え」「メタデータだけ書き換え」の両方を検出できる。
 */
export function composeAttestationDigest(contentSha256: Sha256Hex, metadataSha256: Sha256Hex): Sha256Hex {
  return sha256HexText(`dencho-attestation/v1:${contentSha256}:${metadataSha256}`);
}

/** タイムスタンプトークンをチェーンに取り込むためのハッシュ。 */
export function hashTimestampToken(token: unknown | null): Sha256Hex | null {
  return token === null ? null : sha256HexOf(token);
}

/** 定数時間比較。ハッシュの比較に使う。 */
export function hashesEqual(left: string, right: string): boolean {
  if (left.length !== right.length) {
    return false;
  }
  return timingSafeEqual(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

/** 16 進 64 文字の SHA-256 表現かを検証する。 */
export function isSha256Hex(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}

/** 内容アドレスから保存キーを組み立てる（`aa/bb/<hash>` でファイル数を分散）。 */
export function contentKey(prefix: string, hash: Sha256Hex): string {
  return `${prefix}/${hash.slice(0, 2)}/${hash.slice(2, 4)}/${hash}`;
}


// ---------------------------------------------------------------------------
// 保存キーの規約
// ---------------------------------------------------------------------------

/** 証憑データ本体の保存プレフィックス。 */
export const OBJECT_KEY_PREFIX = 'objects';

/** メタデータ封筒の保存プレフィックス。 */
export const METADATA_KEY_PREFIX = 'metadata';

/** 証憑データ本体の保存キー（内容アドレス）。 */
export function objectKeyFor(contentSha256: Sha256Hex): string {
  return contentKey(OBJECT_KEY_PREFIX, contentSha256);
}

/** メタデータ封筒の保存キー（内容アドレス）。 */
export function metadataKeyFor(metadataSha256: Sha256Hex): string {
  return contentKey(METADATA_KEY_PREFIX, metadataSha256);
}
