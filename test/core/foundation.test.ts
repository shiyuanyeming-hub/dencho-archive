/**
 * コア基盤（正規化・ハッシュ・時刻・タイムスタンプ）のテスト。
 *
 * ここが壊れるとチェーン検証の意味が失われるため、
 * 仕様として固定する（実装の写経ではない）。
 */
import { describe, expect, it } from 'vitest';
import { CanonicalizationError, canonicalJson } from '../../src/core/canonical.js';
import {
  ZERO_HASH,
  composeAttestationDigest,
  hashTimestampToken,
  isSha256Hex,
  objectKeyFor,
  sha256HexOf,
  sha256HexText,
} from '../../src/core/hash.js';
import {
  FixedClock,
  SystemClock,
  addYears,
  compareIsoDate,
  daysBetween,
  formatIsoDate,
  formatIsoInstant,
  isIsoDateInRange,
  isValidIsoDate,
  isValidIsoInstant,
  parseIsoDate,
  parseIsoInstant,
  startOfJstDay,
} from '../../src/core/time.js';
import { LocalHmacTimestampAuthority, createLocalTimestampAuthority } from '../../src/core/timestamp.js';

describe('canonicalJson', () => {
  it('キーの挿入順に依存せず同じ文字列になる', () => {
    const a = { b: 1, a: 2, c: { z: 3, y: 4 } };
    const b = { c: { y: 4, z: 3 }, a: 2, b: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(canonicalJson(a)).toBe('{"a":2,"b":1,"c":{"y":4,"z":3}}');
  });

  it('空白や改行を含まない', () => {
    expect(canonicalJson({ a: [1, 2] })).toBe('{"a":[1,2]}');
  });

  it('undefined の値はキーごと省略する', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it('配列の要素に undefined があると拒否する（長さの揺れを防ぐ）', () => {
    expect(() => canonicalJson([1, undefined, 3])).toThrow(CanonicalizationError);
  });

  it('小数を拒否する（表現揺れを防ぐ）', () => {
    expect(() => canonicalJson({ amount: 1.5 })).toThrow(/小数/);
  });

  it('NaN / Infinity を拒否する', () => {
    expect(() => canonicalJson(Number.NaN)).toThrow(CanonicalizationError);
    expect(() => canonicalJson(Number.POSITIVE_INFINITY)).toThrow(CanonicalizationError);
  });

  it('-0 は 0 に正規化する', () => {
    expect(canonicalJson(-0)).toBe('0');
  });

  it('Uint8Array と Date を暗黙変換せず拒否する', () => {
    expect(() => canonicalJson(new Uint8Array([1, 2]))).toThrow(/Uint8Array/);
    expect(() => canonicalJson(new Date())).toThrow(/Date/);
  });

  it('日本語のキー・値をそのまま扱える', () => {
    expect(canonicalJson({ 取引先: '株式会社サンプル商事' })).toBe('{"取引先":"株式会社サンプル商事"}');
  });

  it('ネストした構造でも決定的である', () => {
    const value = { list: [{ b: 2, a: 1 }], meta: { version: 1 } };
    expect(canonicalJson(value)).toBe(canonicalJson(JSON.parse(JSON.stringify(value))));
  });
});

describe('hash', () => {
  it('既知の SHA-256 と一致する', () => {
    expect(sha256HexText('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('16 進 64 文字を返す', () => {
    expect(isSha256Hex(sha256HexOf({ a: 1 }))).toBe(true);
    expect(isSha256Hex('xyz')).toBe(false);
  });

  it('先頭ハッシュは全ゼロ 64 文字', () => {
    expect(ZERO_HASH).toHaveLength(64);
    expect(/^0+$/.test(ZERO_HASH)).toBe(true);
  });

  it('正規化してからハッシュするため、キー順が違っても同じ値になる', () => {
    expect(sha256HexOf({ a: 1, b: 2 })).toBe(sha256HexOf({ b: 2, a: 1 }));
  });

  it('証明対象ダイジェストは本体とメタデータの両方に依存する', () => {
    const content = 'a'.repeat(64);
    const metadata = 'b'.repeat(64);
    const other = 'c'.repeat(64);
    expect(composeAttestationDigest(content, metadata)).not.toBe(composeAttestationDigest(content, other));
    expect(composeAttestationDigest(content, metadata)).not.toBe(composeAttestationDigest(other, metadata));
    expect(composeAttestationDigest(content, metadata)).toBe(composeAttestationDigest(content, metadata));
  });

  it('タイムスタンプのハッシュは未付与なら null', () => {
    expect(hashTimestampToken(null)).toBeNull();
    expect(hashTimestampToken({ a: 1 })).toHaveLength(64);
  });

  it('保存キーは内容アドレスで分散される', () => {
    const hash = 'ab'.repeat(32);
    expect(objectKeyFor(hash)).toBe(`objects/ab/ab/${hash}`);
  });
});

describe('time（JST）', () => {
  it('UTC の 15:30 は JST では翌日 00:30', () => {
    const instant = new Date('2026-10-31T15:30:00Z');
    expect(formatIsoDate(instant)).toBe('2026-11-01');
    expect(formatIsoInstant(instant)).toBe('2026-11-01T00:30:00+09:00');
  });

  it('日付の妥当性を検証する（存在しない日付を拒否）', () => {
    expect(isValidIsoDate('2026-02-28')).toBe(true);
    expect(isValidIsoDate('2026-02-30')).toBe(false);
    expect(isValidIsoDate('2026-13-01')).toBe(false);
    expect(isValidIsoDate('2026-1-1')).toBe(false);
  });

  it('オフセット付き RFC3339 を検証する', () => {
    expect(isValidIsoInstant('2026-10-31T18:30:00+09:00')).toBe(true);
    expect(isValidIsoInstant('2026-10-31T09:30:00Z')).toBe(true);
    expect(isValidIsoInstant('2026-10-31T18:30:00')).toBe(false);
    expect(isValidIsoInstant('2026-10-31')).toBe(false);
  });

  it('日付文字列は JST の 00:00 として解釈する', () => {
    expect(parseIsoDate('2026-10-31').toISOString()).toBe('2026-10-30T15:00:00.000Z');
  });

  it('日付の差分は切り捨ての日数で返す', () => {
    const from = parseIsoInstant('2026-01-01T00:00:00+09:00');
    const to = parseIsoInstant('2026-01-31T23:59:59+09:00');
    expect(daysBetween(from, to)).toBe(30);
  });

  it('タイムスタンプ付与期限（2 か月）の判定に使える', () => {
    const received = parseIsoInstant('2026-01-01T09:00:00+09:00');
    expect(daysBetween(received, parseIsoInstant('2026-02-28T09:00:00+09:00'))).toBe(58);
    expect(daysBetween(received, parseIsoInstant('2026-03-10T09:00:00+09:00'))).toBe(68);
  });

  it('年を加算できる（保存期間の判定用）', () => {
    expect(formatIsoDate(addYears(parseIsoDate('2026-10-31'), 7))).toBe('2033-10-31');
  });

  it('日付の比較と範囲判定', () => {
    expect(compareIsoDate('2026-01-01', '2026-01-02')).toBeLessThan(0);
    expect(compareIsoDate('2026-01-02', '2026-01-02')).toBe(0);
    expect(isIsoDateInRange('2026-02-01', '2026-01-01', '2026-03-01')).toBe(true);
    expect(isIsoDateInRange('2026-04-01', '2026-01-01', '2026-03-01')).toBe(false);
  });

  it('JST の日の開始を返す', () => {
    expect(formatIsoInstant(startOfJstDay(parseIsoInstant('2026-10-31T18:30:00+09:00')))).toBe(
      '2026-10-31T00:00:00+09:00',
    );
  });

  it('SystemClock は現在時刻を返す', () => {
    expect(SystemClock.prototype.constructor).toBe(SystemClock);
    const now = new SystemClock().now();
    expect(Math.abs(Date.now() - now.getTime())).toBeLessThan(5_000);
  });

  it('FixedClock は進められる', () => {
    const clock = new FixedClock('2026-01-01T09:00:00+09:00');
    expect(formatIsoInstant(clock.now())).toBe('2026-01-01T09:00:00+09:00');
    clock.advance(86_400_000);
    expect(formatIsoInstant(clock.now())).toBe('2026-01-02T09:00:00+09:00');
  });
});

describe('timestamp（ローカル TSA）', () => {
  const digest = sha256HexText('証憑データ');

  function makeAuthority(): LocalHmacTimestampAuthority {
    return new LocalHmacTimestampAuthority({
      secret: 'test-secret-0123456789',
      clock: new FixedClock('2026-01-15T10:00:00+09:00'),
    });
  }

  it('発行したトークンを検証できる', async () => {
    const tsa = makeAuthority();
    const token = await tsa.stamp(digest);
    expect(token.digest).toBe(digest);
    expect(token.digestAlgorithm).toBe('sha256');
    expect(isValidIsoInstant(token.generatedAt)).toBe(true);
    await expect(tsa.verify(token, digest)).resolves.toBe(true);
  });

  it('異なるダイジェストでは検証に失敗する', async () => {
    const tsa = makeAuthority();
    const token = await tsa.stamp(digest);
    await expect(tsa.verify(token, sha256HexText('別のデータ'))).resolves.toBe(false);
  });

  it('トークンを改ざんすると検出できる', async () => {
    const tsa = makeAuthority();
    const token = await tsa.stamp(digest);
    const tampered = { ...token, generatedAt: '2026-01-16T10:00:00+09:00' };
    await expect(tsa.verify(tampered, digest)).resolves.toBe(false);
  });

  it('別の TSA（別の識別子・別の鍵）が発行したトークンは受け付けない', async () => {
    const clock = new FixedClock('2026-01-15T10:00:00+09:00');
    const a = new LocalHmacTimestampAuthority({ id: 'tsa-a', secret: 'secret-aaaaaaaaaaaa', clock });
    const b = new LocalHmacTimestampAuthority({ id: 'tsa-b', secret: 'secret-bbbbbbbbbbbb', clock });
    const token = await a.stamp(digest);
    await expect(b.verify(token, digest)).resolves.toBe(false);
    await expect(a.verify(token, digest)).resolves.toBe(true);
  });

  it('同じ入力なら同じトークンになる（決定的）', async () => {
    const a = makeAuthority();
    const b = makeAuthority();
    const first = await a.stamp(digest, new Date('2026-01-15T10:00:00+09:00'));
    const second = await b.stamp(digest, new Date('2026-01-15T10:00:00+09:00'));
    expect(second).toEqual(first);
  });

  it('鍵が短すぎる場合は生成を拒否する', () => {
    expect(
      () => new LocalHmacTimestampAuthority({ secret: 'short', clock: new FixedClock('2026-01-01T00:00:00+09:00') }),
    ).toThrow(/16 文字以上/);
  });

  it('開発用ファクトリが使える', async () => {
    const tsa = createLocalTimestampAuthority(new FixedClock('2026-01-01T00:00:00+09:00'));
    const token = await tsa.stamp(digest);
    await expect(tsa.verify(token, digest)).resolves.toBe(true);
  });
});
