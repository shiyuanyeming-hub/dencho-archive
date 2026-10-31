/**
 * タイムスタンプ（時刻証明）の抽象と、検証可能なローカル実装。
 *
 * 実運用では RFC 3161 に準拠した TSA（時刻認証局）へダイジェストを送り、
 * TSA が署名したタイムスタンプトークンを証憑と一緒に保存する。
 * 電帳法の真実性の確保では、このトークンが「その時刻にそのデータが
 * 存在した」ことの証拠になる。
 *
 * 本プロジェクトの `LocalHmacTimestampAuthority` は、その構造と検証フローを
 * ローカルだけで再現するための実装で、**法的な時刻証明ではない**。
 * 本番では `TimestampAuthority` ポートを RFC 3161 の実装に差し替える。
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Clock, IsoInstant, Sha256Hex, TimestampAuthority, TimestampToken } from './types.js';
import { formatIsoInstant, isValidIsoInstant } from './time.js';

/** ローカル実装の設定。 */
export interface LocalTimestampAuthorityOptions {
  /** TSA の識別子。レポートに表示される。 */
  readonly id?: string;
  /** 署名鍵（本番では TSA の公開鍵検証に置き換わる）。 */
  readonly secret: string;
  readonly clock: Clock;
}

/** 既定の TSA 識別子。 */
export const DEFAULT_LOCAL_TSA_ID = 'local-hmac-tsa (dev-only)';

/**
 * HMAC で署名された時刻証明を発行するローカル TSA。
 *
 * - 同じダイジェスト・同じ時刻・同じ連番なら同じトークンになる（決定的）。
 * - `verify` は署名・ダイジェスト・TSA 識別子を検証する。
 * - 秘密鍵はプロセス外へ出さない。
 */
export class LocalHmacTimestampAuthority implements TimestampAuthority {
  readonly id: string;
  private readonly secret: string;
  private readonly clock: Clock;
  private counter = 0;

  constructor(options: LocalTimestampAuthorityOptions) {
    if (options.secret.length < 16) {
      throw new Error('タイムスタンプの署名鍵は 16 文字以上にしてください');
    }
    this.id = options.id ?? DEFAULT_LOCAL_TSA_ID;
    this.secret = options.secret;
    this.clock = options.clock;
  }

  async stamp(digest: Sha256Hex, at?: Date): Promise<TimestampToken> {
    const generatedAt = formatIsoInstant(at ?? this.clock.now());
    this.counter += 1;
    const serial = this.makeSerial(digest, generatedAt, this.counter);
    return {
      authority: this.id,
      serial,
      digestAlgorithm: 'sha256',
      digest,
      generatedAt,
      signature: this.sign(serial, digest, generatedAt),
    };
  }

  async verify(token: TimestampToken, digest: Sha256Hex): Promise<boolean> {
    if (token.authority !== this.id) {
      return false;
    }
    if (token.digestAlgorithm !== 'sha256' || token.digest !== digest) {
      return false;
    }
    if (!isValidIsoInstant(token.generatedAt)) {
      return false;
    }
    const expected = this.sign(token.serial, token.digest, token.generatedAt);
    return constantTimeEquals(expected, token.signature);
  }

  /** トークンの発行時刻を返す。 */
  static issuedAt(token: TimestampToken): IsoInstant {
    return token.generatedAt;
  }

  private makeSerial(digest: Sha256Hex, generatedAt: IsoInstant, counter: number): string {
    const material = `${this.id}|${digest}|${generatedAt}|${counter}`;
    return createHmac('sha256', this.secret).update(material).digest('hex').slice(0, 32);
  }

  private sign(serial: string, digest: Sha256Hex, generatedAt: IsoInstant): string {
    const material = `${this.id}|${serial}|${digest}|${generatedAt}`;
    return createHmac('sha256', this.secret).update(material).digest('hex');
  }
}

function constantTimeEquals(left: string, right: string): boolean {
  if (left.length !== right.length) {
    return false;
  }
  return timingSafeEqual(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

/** 開発・テスト用の TSA を作る。 */
export function createLocalTimestampAuthority(clock: Clock, secret = 'dencho-local-dev-secret'): TimestampAuthority {
  return new LocalHmacTimestampAuthority({ secret, clock });
}
