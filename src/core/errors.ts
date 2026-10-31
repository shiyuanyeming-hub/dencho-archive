/**
 * ドメイン固有のエラークラス。
 *
 * CLI と Lambda ハンドラはこれらを捕捉して、利用者向けのメッセージと
 * 終了コードへ変換する。汎用の `Error` を投げると、どこで何が起きたかを
 * 呼び出し側が判別できなくなるため、種別ごとに分けている。
 */

/** すべてのドメインエラーの基底。 */
export class ArchiveError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** 入力値が不正。 */
export class ValidationError extends ArchiveError {
  constructor(message: string, details?: Readonly<Record<string, unknown>>) {
    super(message, 'VALIDATION', details);
  }
}

/** 対象が存在しない。 */
export class NotFoundError extends ArchiveError {
  constructor(message: string, details?: Readonly<Record<string, unknown>>) {
    super(message, 'NOT_FOUND', details);
  }
}

/** 一意性・状態の競合。 */
export class ConflictError extends ArchiveError {
  constructor(message: string, details?: Readonly<Record<string, unknown>>) {
    super(message, 'CONFLICT', details);
  }
}

/**
 * 台帳への追記が競合した（読み出し後に先頭が変わった）。
 * 呼び出し側は再読み込みしてリトライする。
 */
export class ChainConflictError extends ConflictError {
  constructor(
    readonly expectedSequence: number,
    readonly actualSequence: number,
  ) {
    super(
      `台帳の先頭が変わりました（期待: 第 ${expectedSequence} 項 / 実際: 第 ${actualSequence} 項）。再読み込みしてリトライしてください`,
      { expectedSequence, actualSequence },
    );
    this.name = 'ChainConflictError';
  }
}

/** 保存データの整合性が取れていない（改ざん・破損）。 */
export class IntegrityError extends ArchiveError {
  constructor(message: string, details?: Readonly<Record<string, unknown>>) {
    super(message, 'INTEGRITY', details);
  }
}
