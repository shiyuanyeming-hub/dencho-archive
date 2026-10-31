/**
 * アーカイブ系ルール（AUTH / VIS / RET / DL）のテスト。
 *
 * 各ルールについて「pass する正常系」と「fail する異常系」を最低 1 件ずつ固定し、
 * 証跡に残る根拠（件数・ID・日数）まで検証する。
 */
import { describe, expect, it } from 'vitest';
import {
  EMPTY_INFRA,
  evaluateRule,
  evidenceText,
  hashOf,
  makeArchiveView,
  makeChain,
  makeContext,
  makeInfra,
  makeTimestamp,
  makeVoucher,
  makeVouchers,
} from './fixtures.js';

describe('AUTH-01 全証憑にタイムスタンプが付与されている', () => {
  it('全証憑に付与済みなら pass し、付与状況の件数を証跡に残す', async () => {
    const evaluation = await evaluateRule('AUTH-01', makeContext());
    expect(evaluation.status).toBe('pass');
    const text = evidenceText(evaluation);
    expect(text).toContain('付与済み 2 件 / 未付与 0 件');
    expect(text).toContain('対象 2 件');
  });

  it('未付与があれば fail し、未付与 voucherId の先頭 5 件だけを証跡に載せる', async () => {
    const archive = makeArchiveView({ vouchers: makeVouchers(6, () => ({ timestamp: null })) });
    const evaluation = await evaluateRule('AUTH-01', makeContext({ archive }));
    expect(evaluation.status).toBe('fail');
    const text = evidenceText(evaluation);
    expect(text).toContain('未付与 6 件');
    expect(text).toContain('v-001');
    expect(text).toContain('v-005');
    expect(text).not.toContain('v-006');
    expect(evaluation.remediation).toBeDefined();
  });

  it('requireTimestamp=false の運用では not-applicable になる', async () => {
    const archive = makeArchiveView({ vouchers: makeVouchers(2, () => ({ timestamp: null })) });
    const evaluation = await evaluateRule(
      'AUTH-01',
      makeContext({ archive, config: { requireTimestamp: false } }),
    );
    expect(evaluation.status).toBe('not-applicable');
    expect(evidenceText(evaluation)).toContain('requireTimestamp=false');
  });

  it('証憑が 0 件なら付与漏れなしとして pass する', async () => {
    const archive = makeArchiveView({ vouchers: [] });
    const evaluation = await evaluateRule('AUTH-01', makeContext({ archive }));
    expect(evaluation.status).toBe('pass');
    expect(evidenceText(evaluation)).toContain('0 件のため');
  });
});

describe('AUTH-02 タイムスタンプ付与が受領後 62 日以内', () => {
  it('期限内（受領から 28 日後）なら pass する', async () => {
    const evaluation = await evaluateRule('AUTH-02', makeContext());
    expect(evaluation.status).toBe('pass');
    expect(evidenceText(evaluation)).toContain('最大 28 日');
  });

  it('ちょうど 62 日後なら pass する（境界）', async () => {
    const voucher = makeVoucher({
      receivedAt: '2026-08-01T00:00:00+09:00',
      timestamp: makeTimestamp({ generatedAt: '2026-10-02T00:00:00+09:00' }),
    });
    const archive = makeArchiveView({ vouchers: [voucher] });
    const evaluation = await evaluateRule('AUTH-02', makeContext({ archive }));
    expect(evaluation.status).toBe('pass');
  });

  it('63 日後なら fail し、違反した voucherId と日数を証跡に残す', async () => {
    const voucher = makeVoucher({
      voucherId: 'v-late',
      receivedAt: '2026-08-01T00:00:00+09:00',
      timestamp: makeTimestamp({ generatedAt: '2026-10-03T00:00:00+09:00' }),
    });
    const archive = makeArchiveView({ vouchers: [voucher] });
    const evaluation = await evaluateRule('AUTH-02', makeContext({ archive }));
    expect(evaluation.status).toBe('fail');
    const text = evidenceText(evaluation);
    expect(text).toContain('v-late');
    expect(text).toContain('63 日後');
  });

  it('違反の証跡行は voucherId から始まる（運用担当が特定しやすい形式）', async () => {
    const voucher = makeVoucher({
      voucherId: 'INV-001',
      receivedAt: '2026-08-01T00:00:00+09:00',
      timestamp: makeTimestamp({ generatedAt: '2026-10-03T00:00:00+09:00' }),
    });
    const archive = makeArchiveView({ vouchers: [voucher] });
    const evaluation = await evaluateRule('AUTH-02', makeContext({ archive }));
    const violation = evaluation.evidence.find((item) => item.subject === 'INV-001');
    expect(violation?.detail.startsWith('INV-001: 受領から 63 日後に付与')).toBe(true);
  });

  it('タイムスタンプが受領時刻より前なら fail する', async () => {
    const voucher = makeVoucher({
      receivedAt: '2026-10-05T00:00:00+09:00',
      timestamp: makeTimestamp({ generatedAt: '2026-10-01T00:00:00+09:00' }),
    });
    const archive = makeArchiveView({ vouchers: [voucher] });
    const evaluation = await evaluateRule('AUTH-02', makeContext({ archive }));
    expect(evaluation.status).toBe('fail');
    expect(evidenceText(evaluation)).toContain('受領時刻より前');
  });

  it('受領時刻の形式が不正でも例外を投げず fail にする', async () => {
    const voucher = makeVoucher({ receivedAt: 'not-an-instant' });
    const archive = makeArchiveView({ vouchers: [voucher] });
    const evaluation = await evaluateRule('AUTH-02', makeContext({ archive }));
    expect(evaluation.status).toBe('fail');
    expect(evidenceText(evaluation)).toContain('形式が不正');
  });

  it('トークンが 1 件も無い場合は判定対象なしとして pass する', async () => {
    const archive = makeArchiveView({ vouchers: makeVouchers(2, () => ({ timestamp: null })) });
    const evaluation = await evaluateRule('AUTH-02', makeContext({ archive }));
    expect(evaluation.status).toBe('pass');
    expect(evidenceText(evaluation)).toContain('判定対象はありません');
  });
});

describe('AUTH-03 タイムスタンプの検証に失敗していない', () => {
  it('整合したチェーンなら pass する', async () => {
    const evaluation = await evaluateRule('AUTH-03', makeContext());
    expect(evaluation.status).toBe('pass');
    expect(evidenceText(evaluation)).toContain('タイムスタンプ検証の失敗は検出されていません');
  });

  it('チェーン破損理由が timestamp-mismatch なら fail する', async () => {
    const chain = makeChain({
      status: 'broken',
      break: {
        sequence: 2,
        reason: 'timestamp-mismatch',
        expected: hashOf('expected'),
        actual: hashOf('actual'),
        voucherId: 'v-002',
      },
    });
    const archive = makeArchiveView({ chain });
    const evaluation = await evaluateRule('AUTH-03', makeContext({ archive }));
    expect(evaluation.status).toBe('fail');
    const text = evidenceText(evaluation);
    expect(text).toContain('タイムスタンプの検証に失敗');
    expect(text).toContain('v-002');
  });

  it('タイムスタンプ以外の理由の破損では pass する（AUTH-04 の担当）', async () => {
    const chain = makeChain({
      status: 'broken',
      break: {
        sequence: 1,
        reason: 'content-mismatch',
        expected: hashOf('expected'),
        actual: hashOf('actual'),
        voucherId: 'v-001',
      },
    });
    const archive = makeArchiveView({ chain });
    const evaluation = await evaluateRule('AUTH-03', makeContext({ archive }));
    expect(evaluation.status).toBe('pass');
  });
});

describe('AUTH-04 ハッシュチェーンが整合している', () => {
  it('健全なチェーンなら pass し、検証件数と先頭ハッシュを証跡に残す', async () => {
    const evaluation = await evaluateRule('AUTH-04', makeContext());
    expect(evaluation.status).toBe('pass');
    const text = evidenceText(evaluation);
    expect(text).toContain('検証済みエントリ数: 2 件');
    expect(text).toContain('チェックポイントは台帳と整合しています');
  });

  it('空の台帳でも整合しているものとして pass する', async () => {
    const chain = makeChain({ status: 'empty', checkedEntries: 0, headHash: null });
    const archive = makeArchiveView({ vouchers: [], chain });
    const evaluation = await evaluateRule('AUTH-04', makeContext({ archive }));
    expect(evaluation.status).toBe('pass');
    expect(evidenceText(evaluation)).toContain('台帳が空');
  });

  it('チェーンが破損していれば fail し、位置と理由を証跡に残す', async () => {
    const chain = makeChain({
      status: 'broken',
      break: {
        sequence: 3,
        reason: 'chain-link-mismatch',
        expected: hashOf('expected'),
        actual: hashOf('actual'),
        voucherId: 'v-003',
      },
    });
    const archive = makeArchiveView({ chain });
    const evaluation = await evaluateRule('AUTH-04', makeContext({ archive }));
    expect(evaluation.status).toBe('fail');
    const text = evidenceText(evaluation);
    expect(text).toContain('第 3 項');
    expect(text).toContain('チェーンリンクの不一致');
    expect(text).toContain('v-003');
  });

  it('チェックポイントが一致しなければ fail する', async () => {
    const archive = makeArchiveView({ chain: makeChain({ checkpointsVerified: false }) });
    const evaluation = await evaluateRule('AUTH-04', makeContext({ archive }));
    expect(evaluation.status).toBe('fail');
    expect(evidenceText(evaluation)).toContain('チェックポイントのハッシュが台帳と一致しません');
  });
});

describe('AUTH-05 WORM または訂正削除履歴による真実性確保', () => {
  it('タイムスタンプ方式を採用している場合は not-applicable になる', async () => {
    const evaluation = await evaluateRule('AUTH-05', makeContext());
    expect(evaluation.status).toBe('not-applicable');
    expect(evidenceText(evaluation)).toContain('タイムスタンプ方式を採用しているため');
  });

  it('タイムスタンプ方式を採らず worm=true なら pass する', async () => {
    const evaluation = await evaluateRule(
      'AUTH-05',
      makeContext({ config: { requireTimestamp: false, worm: true } }),
    );
    expect(evaluation.status).toBe('pass');
    expect(evidenceText(evaluation)).toContain('WORM（書き込み後変更不可）');
  });

  it('タイムスタンプ方式を採らずインフラの Object Lock が COMPLIANCE / 2557 日なら pass する', async () => {
    const evaluation = await evaluateRule(
      'AUTH-05',
      makeContext({ config: { requireTimestamp: false, worm: false }, infra: makeInfra() }),
    );
    expect(evaluation.status).toBe('pass');
    expect(evidenceText(evaluation)).toContain('S3 Object Lock（COMPLIANCE / 2557 日以上）');
  });

  it('タイムスタンプも WORM も無ければ必須ルールとして fail する', async () => {
    const evaluation = await evaluateRule(
      'AUTH-05',
      makeContext({ config: { requireTimestamp: false, worm: false } }),
    );
    expect(evaluation.status).toBe('fail');
    expect(evidenceText(evaluation)).toContain('インフラ定義が提供されていない');
    expect(evaluation.remediation).toContain('訂正削除の履歴');
  });

  it('Object Lock が無効なら fail する', async () => {
    const evaluation = await evaluateRule(
      'AUTH-05',
      makeContext({
        config: { requireTimestamp: false, worm: false },
        infra: makeInfra({ objectLockEnabled: false, objectLockConfigured: false }),
      }),
    );
    expect(evaluation.status).toBe('fail');
    expect(evidenceText(evaluation)).toContain('S3 Object Lock: 無効');
  });

  it('Object Lock が有効でも GOVERNANCE モードでは pass にしない', async () => {
    const evaluation = await evaluateRule(
      'AUTH-05',
      makeContext({
        config: { requireTimestamp: false, worm: false },
        infra: makeInfra({ retentionMode: 'GOVERNANCE' }),
      }),
    );
    expect(evaluation.status).toBe('fail');
    expect(evidenceText(evaluation)).toContain('保持モード: GOVERNANCE');
  });

  it('インフラにバケットが無い場合は「リソースが見つかりません」を証跡に残す', async () => {
    const evaluation = await evaluateRule(
      'AUTH-05',
      makeContext({ config: { requireTimestamp: false, worm: false }, infra: EMPTY_INFRA }),
    );
    expect(evaluation.status).toBe('fail');
    expect(evidenceText(evaluation)).toContain('リソースが見つかりません');
  });
});

describe('VIS-01 検索対象3項目が索引化されている', () => {
  it('3 項目すべて索引化されていれば pass する', async () => {
    const evaluation = await evaluateRule('VIS-01', makeContext());
    expect(evaluation.status).toBe('pass');
    expect(evidenceText(evaluation)).toContain('3 項目すべてが索引化されています');
  });

  it('取引先が索引化されていなければ fail する', async () => {
    const archive = makeArchiveView({
      capability: { searchableFields: ['transactionDate', 'amount'] },
    });
    const evaluation = await evaluateRule('VIS-01', makeContext({ archive }));
    expect(evaluation.status).toBe('fail');
    expect(evidenceText(evaluation)).toContain('取引先');
  });

  it('取引金額が索引化されていなければ fail する', async () => {
    const archive = makeArchiveView({
      capability: { searchableFields: ['transactionDate', 'counterparty'] },
    });
    const evaluation = await evaluateRule('VIS-01', makeContext({ archive }));
    expect(evaluation.status).toBe('fail');
    expect(evidenceText(evaluation)).toContain('取引金額');
  });
});

describe('VIS-02 2項目以上の組み合わせ検索が可能', () => {
  it('組み合わせ検索に対応していれば pass し、組み合わせ数を証跡に残す', async () => {
    const evaluation = await evaluateRule('VIS-02', makeContext());
    expect(evaluation.status).toBe('pass');
    const text = evidenceText(evaluation);
    expect(text).toContain('対応している組み合わせ');
    expect(text).toContain('3');
  });

  it('組み合わせ検索が 0 件なら fail する', async () => {
    const archive = makeArchiveView({ capability: { twoFieldCombinations: [] } });
    const evaluation = await evaluateRule('VIS-02', makeContext({ archive }));
    expect(evaluation.status).toBe('fail');
    expect(evidenceText(evaluation)).toContain('対応していません');
  });
});

describe('VIS-03 日付・金額の範囲指定検索が可能', () => {
  it('日付・金額の両方で範囲指定できれば pass する', async () => {
    const evaluation = await evaluateRule('VIS-03', makeContext());
    expect(evaluation.status).toBe('pass');
  });

  it('日付の範囲指定ができなければ fail する', async () => {
    const archive = makeArchiveView({ capability: { supportsDateRange: false } });
    const evaluation = await evaluateRule('VIS-03', makeContext({ archive }));
    expect(evaluation.status).toBe('fail');
    expect(evidenceText(evaluation)).toContain('取引年月日の範囲指定');
  });

  it('金額の範囲指定ができなければ fail する', async () => {
    const archive = makeArchiveView({ capability: { supportsAmountRange: false } });
    const evaluation = await evaluateRule('VIS-03', makeContext({ archive }));
    expect(evaluation.status).toBe('fail');
    expect(evidenceText(evaluation)).toContain('取引金額の範囲指定');
  });
});

describe('RET-01 保存期間が7年以上', () => {
  it('設定 7 年・インフラ未指定なら pass する', async () => {
    const evaluation = await evaluateRule('RET-01', makeContext());
    expect(evaluation.status).toBe('pass');
    expect(evidenceText(evaluation)).toContain('7 年');
  });

  it('設定 7 年かつ Object Lock 2557 日なら pass する', async () => {
    const evaluation = await evaluateRule('RET-01', makeContext({ infra: makeInfra() }));
    expect(evaluation.status).toBe('pass');
    expect(evidenceText(evaluation)).toContain('2557 日');
  });

  it('設定が 6 年なら fail する', async () => {
    const evaluation = await evaluateRule('RET-01', makeContext({ config: { retentionYears: 6 } }));
    expect(evaluation.status).toBe('fail');
    expect(evidenceText(evaluation)).toContain('6 年');
  });

  it('インフラの Object Lock 保持が 365 日なら fail する', async () => {
    const evaluation = await evaluateRule(
      'RET-01',
      makeContext({ infra: makeInfra({ retentionDays: 365 }) }),
    );
    expect(evaluation.status).toBe('fail');
    expect(evidenceText(evaluation)).toContain('365 日');
  });

  it('インフラに Object Lock のデフォルト保持が無ければ fail する', async () => {
    const evaluation = await evaluateRule(
      'RET-01',
      makeContext({ infra: makeInfra({ objectLockConfigured: false }) }),
    );
    expect(evaluation.status).toBe('fail');
    expect(evidenceText(evaluation)).toContain('DefaultRetention');
  });

  it('インフラにバケットが無ければ「リソースが見つかりません」を証跡に残して fail する', async () => {
    const evaluation = await evaluateRule('RET-01', makeContext({ infra: EMPTY_INFRA }));
    expect(evaluation.status).toBe('fail');
    expect(evidenceText(evaluation)).toContain('リソースが見つかりません');
  });
});

describe('DL-01 税務調査の「ダウンロードの求め」に対応できる', () => {
  it('CSV と JSON の両方を出力できれば pass する', async () => {
    const evaluation = await evaluateRule('DL-01', makeContext());
    expect(evaluation.status).toBe('pass');
    expect(evidenceText(evaluation)).toContain('csv, json');
  });

  it('CSV しか出力できなければ fail する', async () => {
    const archive = makeArchiveView({ capability: { exportFormats: ['csv'] } });
    const evaluation = await evaluateRule('DL-01', makeContext({ archive }));
    expect(evaluation.status).toBe('fail');
    expect(evidenceText(evaluation)).toContain('JSON 形式のダウンロード: 無効');
  });

  it('出力形式が無ければ fail する', async () => {
    const archive = makeArchiveView({ capability: { exportFormats: [] } });
    const evaluation = await evaluateRule('DL-01', makeContext({ archive }));
    expect(evaluation.status).toBe('fail');
    expect(evidenceText(evaluation)).toContain('対応している出力形式: なし');
  });
});
