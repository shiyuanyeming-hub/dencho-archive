/**
 * 時刻と日付の扱い。
 *
 * 電帳法は「取引年月日」と「受領・保存時刻」を要求するため、
 * 日付の切り分けが判定結果に直結する。日本標準時（JST）は
 * 夏時間が無く固定 +09:00 なので、UTC からの固定オフセットで扱い切れる。
 *
 * 設計方針:
 * - 日付は `YYYY-MM-DD`（JST の暦日）、時刻は `+09:00` 付き RFC3339 で持つ。
 * - 比較・差分は UTC のミリ秒で行う（文字列比較での誤りを避ける）。
 * - 「今日」を暗黙に使わない。`Clock` を注入し、テストでは固定する。
 */
import type { Clock, IsoDate, IsoInstant } from './types.js';

/** JST の UTC オフセット（分）。日本には夏時間が無いため固定値でよい。 */
export const JST_OFFSET_MINUTES = 540;

const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 86_400_000;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

/** 日付文字列の形式を検証する。 */
export function isValidIsoDate(value: string): boolean {
  const match = DATE_PATTERN.exec(value);
  if (match === null) {
    return false;
  }
  const year = Number.parseInt(match[1] ?? '', 10);
  const month = Number.parseInt(match[2] ?? '', 10);
  const day = Number.parseInt(match[3] ?? '', 10);
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return false;
  }
  return daysInMonth(year, month) >= day;
}

/** 実在する日付へ正規化する（`2026-02-30` を拒否するため）。 */
function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** オフセット付き RFC3339 かを検証する。 */
export function isValidIsoInstant(value: string): boolean {
  if (!INSTANT_PATTERN.test(value)) {
    return false;
  }
  return !Number.isNaN(Date.parse(value));
}

/** JST の暦日を `YYYY-MM-DD` で返す。 */
export function formatIsoDate(instant: Date): IsoDate {
  const jst = new Date(instant.getTime() + JST_OFFSET_MINUTES * MS_PER_MINUTE);
  const year = jst.getUTCFullYear().toString().padStart(4, '0');
  const month = (jst.getUTCMonth() + 1).toString().padStart(2, '0');
  const day = jst.getUTCDate().toString().padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * JST の RFC3339 文字列を返す（秒精度）。
 *
 * ミリ秒を落とすのは、記録時刻を秒単位に丸めることで
 * 同一秒内の取り込みでも表現が安定するため。
 */
export function formatIsoInstant(instant: Date): IsoInstant {
  const jst = new Date(instant.getTime() + JST_OFFSET_MINUTES * MS_PER_MINUTE);
  const year = jst.getUTCFullYear().toString().padStart(4, '0');
  const month = (jst.getUTCMonth() + 1).toString().padStart(2, '0');
  const day = jst.getUTCDate().toString().padStart(2, '0');
  const hour = jst.getUTCHours().toString().padStart(2, '0');
  const minute = jst.getUTCMinutes().toString().padStart(2, '0');
  const second = jst.getUTCSeconds().toString().padStart(2, '0');
  return `${year}-${month}-${day}T${hour}:${minute}:${second}+09:00`;
}

/** JST の日付文字列を、その日の 00:00 JST を表す Date へ変換する。 */
export function parseIsoDate(value: string): Date {
  if (!isValidIsoDate(value)) {
    throw new Error(`不正な日付です（YYYY-MM-DD 形式で指定してください）: ${value}`);
  }
  return new Date(`${value}T00:00:00+09:00`);
}

/** RFC3339 文字列を Date へ変換する。 */
export function parseIsoInstant(value: string): Date {
  if (!isValidIsoInstant(value)) {
    throw new Error(`不正な時刻です（オフセット付き RFC3339 で指定してください）: ${value}`);
  }
  return new Date(value);
}

/** 2 つの時刻の差を日数（切り捨て）で返す。 */
export function daysBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / MS_PER_DAY);
}

/** 指定した年数を加えた Date を返す（保存期間の判定用）。 */
export function addYears(instant: Date, years: number): Date {
  const result = new Date(instant.getTime());
  result.setUTCFullYear(result.getUTCFullYear() + years);
  return result;
}

/** その時刻が属する JST の日の 00:00 を返す。 */
export function startOfJstDay(instant: Date): Date {
  const jst = new Date(instant.getTime() + JST_OFFSET_MINUTES * MS_PER_MINUTE);
  jst.setUTCHours(0, 0, 0, 0);
  return new Date(jst.getTime() - JST_OFFSET_MINUTES * MS_PER_MINUTE);
}

/** 日付の前後比較（`a < b` なら負、`a === b` なら 0、`a > b` なら正）。 */
export function compareIsoDate(left: IsoDate, right: IsoDate): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

/** 日付が範囲内（両端含む）か。片側だけの指定も可。 */
export function isIsoDateInRange(date: IsoDate, from: IsoDate | undefined, to: IsoDate | undefined): boolean {
  if (from !== undefined && compareIsoDate(date, from) < 0) {
    return false;
  }
  if (to !== undefined && compareIsoDate(date, to) > 0) {
    return false;
  }
  return true;
}

/** 実時刻を返すクロック。 */
export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

/** テスト・デモ用の固定クロック。 */
export class FixedClock implements Clock {
  private current: Date;

  constructor(initial: Date | string) {
    this.current = typeof initial === 'string' ? parseIsoInstant(initial) : new Date(initial.getTime());
  }

  now(): Date {
    return new Date(this.current.getTime());
  }

  /** 時刻を進める（デモで「時間が経過した」状況を作る）。 */
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }

  /** 時刻を指定値へ変更する。 */
  setTo(instant: Date | string): void {
    this.current = typeof instant === 'string' ? parseIsoInstant(instant) : new Date(instant.getTime());
  }
}
