/**
 * 決定的シリアライズ（正規化 JSON）。
 *
 * ハッシュチェーンの入力は「同じ内容なら必ず同じバイト列」にならなければ
 * ならない。`JSON.stringify` はキー順がオブジェクトの生成順に依存し、
 * 同一内容でも異なる文字列になり得るため、ここで規則を固定する。
 *
 * 規則:
 * - オブジェクトのキーは UTF-16 コードユニット順（`Array.prototype.sort` の既定）で並べる
 * - 空白・改行を一切入れない
 * - `undefined` の値を持つキーは省略する（`JSON.stringify` と同じ）
 * - 数値は整数のみ許可する。小数は表現揺れ（`1.0` と `1`、指数表記）の温床なので、
 *   金額や年数に小数を持ち込まない設計とし、入力段階で拒否する
 * - `NaN` / `Infinity` / 関数 / シンボル / BigInt は拒否する（黙って欠落させない）
 * - `Uint8Array` は拒否する。バイト列は呼び出し側で 16 進か base64 に変換すること
 *   （暗黙の変換は環境依存の差異を生みやすい）
 */

/** 正規化に失敗したことを表す。 */
export class CanonicalizationError extends Error {
  constructor(message: string, readonly path: string) {
    super(`${message} (at ${path})`);
    this.name = 'CanonicalizationError';
  }
}

/** 値を決定的な JSON 文字列へ変換する。 */
export function canonicalJson(value: unknown): string {
  return serialize(value, '$');
}

/** 値を決定的な UTF-8 バイト列へ変換する。 */
export function canonicalBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalJson(value));
}

function serialize(value: unknown, path: string): string {
  if (value === null) {
    return 'null';
  }

  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';

    case 'number':
      return serializedNumber(value, path);

    case 'string':
      return JSON.stringify(value);

    case 'undefined':
      throw new CanonicalizationError('undefined は直列化できません', path);

    case 'function':
    case 'symbol':
    case 'bigint':
      throw new CanonicalizationError(`${typeof value} は直列化できません`, path);

    case 'object':
      return Array.isArray(value) ? serializeArray(value, path) : serializeObject(value, path);

    default:
      throw new CanonicalizationError(`未対応の型です: ${typeof value}`, path);
  }
}

function serializedNumber(value: number, path: string): string {
  if (!Number.isFinite(value)) {
    throw new CanonicalizationError('NaN / Infinity は直列化できません', path);
  }
  if (!Number.isInteger(value)) {
    throw new CanonicalizationError(
      `小数は直列化できません（金額・年数は整数で保持すること）: ${String(value)}`,
      path,
    );
  }
  // -0 を 0 に正規化する（String(-0) は "0" になるが、意図を明示する）。
  return String(value === 0 ? 0 : value);
}

function serializeArray(value: readonly unknown[], path: string): string {
  const parts: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    if (item === undefined) {
      throw new CanonicalizationError(
        '配列要素に undefined は使えません（長さが変わるとハッシュが変わります）',
        `${path}[${index}]`,
      );
    }
    parts.push(serialize(item, `${path}[${index}]`));
  }
  return `[${parts.join(',')}]`;
}

function serializeObject(value: object, path: string): string {
  if (value instanceof Uint8Array) {
    throw new CanonicalizationError(
      'Uint8Array は直接直列化できません（16 進文字列などへ明示的に変換してください）',
      path,
    );
  }
  if (value instanceof Date) {
    throw new CanonicalizationError('Date は直接直列化できません（ISO 文字列に変換してください）', path);
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const parts: string[] = [];
  for (const key of keys) {
    const item = record[key];
    if (item === undefined) {
      continue;
    }
    parts.push(`${JSON.stringify(key)}:${serialize(item, `${path}.${key}`)}`);
  }
  return `{${parts.join(',')}}`;
}
