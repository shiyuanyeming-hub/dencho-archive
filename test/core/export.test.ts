/**
 * 税務調査の「ダウンロードの求め」に応える出力のテスト。
 *
 * Excel で開いても文字化けしないこと（UTF-8 BOM）、列が壊れないこと
 * （RFC4180 の引用符処理）、非機密フィールドだけを出すこと、
 * 同じ入力からは同じバイト列になること（監査証跡として比較可能）を固定する。
 */

import { describe, expect, it } from 'vitest';

import type { DocumentType, ExportResult, StoredVoucher, TimestampToken } from '../../src/core/types.js';
import { ValidationError } from '../../src/core/errors.js';
import { renderExport, type ExportParams } from '../../src/core/export.js';

// ---------------------------------------------------------------------------
// フィクスチャ
// ---------------------------------------------------------------------------

/** 帯用のタイムスタンプトークン（生成時刻は保存時刻とずらしてある）。 */
const TIMESTAMP: TimestampToken = {
  authority: 'local-hmac-tsa (dev-only)',
  serial: '1',
  digestAlgorithm: 'sha256',
  digest: 'a'.repeat(64),
  generatedAt: '2026-01-06T10:00:05+09:00',
  signature: 'hmac-signature-value',
};

/** テスト用の保存済み証憑を作る。 */
function makeVoucher(
  overrides: {
    readonly voucherId?: string;
    readonly transactionDate?: string;
    readonly amountYen?: number;
    readonly counterpartyName?: string;
    readonly documentType?: DocumentType;
    readonly originalFileName?: string;
    readonly recordedAt?: string;
    readonly timestamp?: TimestampToken | null;
    readonly tags?: readonly string[];
  } = {},
): StoredVoucher {
  return {
    voucherId: overrides.voucherId ?? 'v-001',
    sequence: 1,
    transactionDate: overrides.transactionDate ?? '2026-01-05',
    amountYen: overrides.amountYen ?? 1_200,
    counterpartyName: overrides.counterpartyName ?? '株式会社サンプル商事',
    counterpartyNormalized: 'サンプル商事',
    documentType: overrides.documentType ?? 'invoice',
    originalFileName: overrides.originalFileName ?? 'invoice-001.pdf',
    mediaType: 'application/pdf',
    objectKey: `objects/aa/bb/${'a'.repeat(64)}`,
    contentSha256: 'a'.repeat(64),
    metadataSha256: 'b'.repeat(64),
    entryHash: 'c'.repeat(64),
    recordedAt: overrides.recordedAt ?? '2026-01-06T10:00:00+09:00',
    receivedAt: '2026-01-05T12:00:00+09:00',
    timestamp: overrides.timestamp === undefined ? TIMESTAMP : overrides.timestamp,
    tags: overrides.tags ?? ['2026'],
    note: null,
  };
}

/** CSV / JSON の共通パラメータ。 */
function params(
  format: ExportParams['format'],
  vouchers: readonly StoredVoucher[] = [makeVoucher()],
): ExportParams {
  return {
    format,
    vouchers,
    archiveId: 'arch-001',
    generatedAt: '2026-10-31T18:30:00+09:00',
  };
}

/** 出力バイト列を文字列へ戻す（BOM は TextDecoder が取り除く）。 */
function decode(result: ExportResult): string {
  return new TextDecoder('utf-8').decode(result.bytes);
}

/** JSON 出力の型（テスト内で検証する範囲だけを型付けする）。 */
interface JsonExport {
  readonly schemaVersion: number;
  readonly archiveId: string;
  readonly generatedAt: string;
  readonly count: number;
  readonly vouchers: readonly Record<string, unknown>[];
}

/** JSON 出力をパースする。 */
function parseJson(result: ExportResult): JsonExport {
  return JSON.parse(decode(result)) as JsonExport;
}

/** JSON 出力の先頭証憑を取り出す（無ければテスト失敗）。 */
function firstVoucher(exported: JsonExport): Record<string, unknown> {
  const first = exported.vouchers[0];
  if (first === undefined) {
    throw new Error('証憑が 1 件も出力されていません');
  }
  return first;
}

/** 1 件分の CSV データ行を取り出す（ヘッダ行の次）。 */
function firstDataRow(result: ExportResult): string {
  const row = decode(result).split('\r\n')[1];
  if (row === undefined) {
    throw new Error('CSV のデータ行がありません');
  }
  return row;
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

describe('CSV 出力', () => {
  it('UTF-8 BOM で始まる（Excel で文字化けしない）', () => {
    const result = renderExport(params('csv'));
    expect(result.bytes[0]).toBe(0xef);
    expect(result.bytes[1]).toBe(0xbb);
    expect(result.bytes[2]).toBe(0xbf);
    // ignoreBOM で読むと BOM 文字そのものを確認できる。
    const withBom = new TextDecoder('utf-8', { ignoreBOM: true }).decode(result.bytes);
    expect(withBom.startsWith('\uFEFF')).toBe(true);
  });

  it('日本語ヘッダを 10 列で出力する', () => {
    const result = renderExport(params('csv'));
    expect(decode(result).split('\r\n')[0]).toBe(
      '取引年月日,取引金額,取引先,書類種別,証憑ID,ファイル名,登録番号,保存時刻,証憑ハッシュ,タイムスタンプ',
    );
  });

  it('改行は CRLF のみを使い、末尾も CRLF で終わる（RFC4180）', () => {
    const vouchers = [makeVoucher(), makeVoucher({ voucherId: 'v-002' })];
    const text = decode(renderExport(params('csv', vouchers)));
    expect(text.endsWith('\r\n')).toBe(true);
    expect(text.replaceAll('\r\n', '')).not.toContain('\n');
    // ヘッダ + 2 行 = 3 レコード。
    expect(text.split('\r\n').filter((line) => line.length > 0)).toHaveLength(3);
  });

  it('1 行の値が設計どおり（金額は整数・書類種別は日本語・登録番号は空欄）', () => {
    const row = firstDataRow(renderExport(params('csv')));
    expect(row).toBe(
      `2026-01-05,1200,株式会社サンプル商事,請求書,v-001,invoice-001.pdf,,2026-01-06T10:00:00+09:00,${'a'.repeat(64)},2026-01-06T10:00:05+09:00`,
    );
  });

  it('カンマを含む値は引用符で囲む', () => {
    const result = renderExport(params('csv', [makeVoucher({ counterpartyName: 'サンプル,商事' })]));
    expect(firstDataRow(result)).toContain(',"サンプル,商事",');
  });

  it('引用符は 2 つ重ねてエスケープする', () => {
    const result = renderExport(params('csv', [makeVoucher({ counterpartyName: 'A,B"商事' })]));
    expect(firstDataRow(result)).toContain('"A,B""商事"');
  });

  it('改行を含む値は引用符で囲む（列が壊れない）', () => {
    const result = renderExport(params('csv', [makeVoucher({ originalFileName: 'invoice\n001.pdf' })]));
    expect(firstDataRow(result)).toContain('"invoice\n001.pdf"');
  });

  it('タイムスタンプ未付与は空欄になる', () => {
    const result = renderExport(params('csv', [makeVoucher({ timestamp: null })]));
    const row = firstDataRow(result);
    expect(row.endsWith(',')).toBe(true);
    expect(row.split(',').at(-1)).toBe('');
  });

  it('金額 0 と 12 桁金額を桁区切りなしで出力する', () => {
    const result = renderExport(
      params('csv', [
        makeVoucher({ voucherId: 'v-zero', amountYen: 0 }),
        makeVoucher({ voucherId: 'v-large', amountYen: 999_999_999_999 }),
      ]),
    );
    const text = decode(result);
    expect(text).toContain('v-zero');
    expect(text).toContain(',0,');
    expect(text).toContain(',999999999999,');
  });

  it('rowCount / fileName / mediaType を返す', () => {
    const result = renderExport(params('csv', [makeVoucher(), makeVoucher({ voucherId: 'v-002' })]));
    expect(result.rowCount).toBe(2);
    expect(result.fileName).toBe('dencho-arch-001-20261031T093000Z.csv');
    expect(result.mediaType).toBe('text/csv; charset=utf-8');
  });

  it('空の一覧でもヘッダだけの CSV を返す', () => {
    const result = renderExport(params('csv', []));
    expect(result.rowCount).toBe(0);
    const text = decode(result);
    expect(text).toBe(
      `取引年月日,取引金額,取引先,書類種別,証憑ID,ファイル名,登録番号,保存時刻,証憑ハッシュ,タイムスタンプ\r\n`,
    );
  });

  it('同じ入力からは同じバイト列を返す（決定的）', () => {
    const first = renderExport(params('csv', [makeVoucher()]));
    const second = renderExport(params('csv', [makeVoucher()]));
    expect(first.bytes).toEqual(second.bytes);
    expect(first.fileName).toBe(second.fileName);
  });
});

// ---------------------------------------------------------------------------
// JSON
// ---------------------------------------------------------------------------

describe('JSON 出力', () => {
  it('トップレベル構造は schemaVersion 1 / archiveId / generatedAt / count / vouchers', () => {
    const exported = parseJson(renderExport(params('json')));
    expect(exported.schemaVersion).toBe(1);
    expect(exported.archiveId).toBe('arch-001');
    expect(exported.generatedAt).toBe('2026-10-31T18:30:00+09:00');
    expect(exported.count).toBe(1);
    expect(exported.vouchers).toHaveLength(1);
  });

  it('証憑は非機密フィールドのみを含む（内部キー・正規化キー・台帳内部ハッシュを出さない）', () => {
    const voucher = firstVoucher(parseJson(renderExport(params('json'))));
    expect(Object.keys(voucher).sort()).toEqual([
      'amountYen',
      'contentSha256',
      'counterpartyName',
      'documentType',
      'mediaType',
      'originalFileName',
      'receivedAt',
      'recordedAt',
      'sequence',
      'tags',
      'timestamp',
      'transactionDate',
      'voucherId',
    ]);
    expect(voucher).not.toHaveProperty('objectKey');
    expect(voucher).not.toHaveProperty('counterpartyNormalized');
    expect(voucher).not.toHaveProperty('metadataSha256');
    expect(voucher).not.toHaveProperty('entryHash');
    expect(voucher).not.toHaveProperty('note');
  });

  it('書類種別は機械可読な列挙値で出す', () => {
    const exported = parseJson(renderExport(params('json', [makeVoucher({ documentType: 'receipt' })])));
    expect(firstVoucher(exported)['documentType']).toBe('receipt');
  });

  it('タイムスタンプトークンと未付与 null をそのまま保持する', () => {
    const withToken = parseJson(renderExport(params('json')));
    expect(firstVoucher(withToken)['timestamp']).toMatchObject({
      authority: 'local-hmac-tsa (dev-only)',
      generatedAt: '2026-01-06T10:00:05+09:00',
    });

    const withoutToken = parseJson(
      renderExport(params('json', [makeVoucher({ timestamp: null })])),
    );
    expect(firstVoucher(withoutToken)['timestamp']).toBeNull();
  });

  it('rowCount / fileName / mediaType を返す', () => {
    const result = renderExport(params('json', [makeVoucher(), makeVoucher({ voucherId: 'v-002' })]));
    expect(result.rowCount).toBe(2);
    expect(result.fileName).toBe('dencho-arch-001-20261031T093000Z.json');
    expect(result.mediaType).toBe('application/json; charset=utf-8');
  });

  it('空の一覧は count 0 / vouchers [] になる', () => {
    const exported = parseJson(renderExport(params('json', [])));
    expect(exported.count).toBe(0);
    expect(exported.vouchers).toEqual([]);
  });

  it('同じ入力からは同じバイト列を返す（決定的）', () => {
    const first = renderExport(params('json', [makeVoucher()]));
    const second = renderExport(params('json', [makeVoucher()]));
    expect(first.bytes).toEqual(second.bytes);
  });

  it('BOM を付けない（JSON の仕様どおり）', () => {
    const result = renderExport(params('json'));
    expect(result.bytes[0]).toBe('{'.charCodeAt(0));
  });
});

// ---------------------------------------------------------------------------
// ファイル名と入力検証
// ---------------------------------------------------------------------------

describe('renderExport の入力', () => {
  it('fileName は archiveId を安全な文字へ落とす', () => {
    const result = renderExport({
      format: 'csv',
      vouchers: [],
      archiveId: 'arch/001 x',
      generatedAt: '2026-10-31T18:30:00+09:00',
    });
    expect(result.fileName).toBe('dencho-arch_001_x-20261031T093000Z.csv');
  });

  it('archiveId が空なら ValidationError', () => {
    expect(() => renderExport({ ...params('csv'), archiveId: '  ' })).toThrow(ValidationError);
  });

  it('generatedAt が不正なら ValidationError', () => {
    expect(() => renderExport({ ...params('csv'), generatedAt: '2026-10-31 18:30:00' })).toThrow(
      ValidationError,
    );
  });
});
