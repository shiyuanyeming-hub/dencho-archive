/**
 * アーカイブ（保存済みデータ）に対する電帳法の適合性ルール。
 *
 * ここで扱うのは「実際に保存されている証憑・台帳・検索機能」の状態であり、
 * インフラ定義（CloudFormation）は参照しない（インフラ系は `infra.ts`）。
 * 唯一の例外は AUTH-05 で、設定 `worm` が false の場合に限り、
 * S3 Object Lock による WORM を確認するためにインフラ定義を参照する。
 *
 * すべてのルールは純粋関数である。例外は投げない（呼び出し側の
 * `evaluateRules` が念のため catch するが、ルール自身も欠損値に耐える）。
 *
 * 参照しているのは「要件名」と国税庁の公開ページのみで、条文番号は引かない。
 */
import type {
  ChainBreakReason,
  ComplianceRule,
  EvidenceItem,
  RuleContext,
  RuleEvaluation,
  SearchField,
  Sha256Hex,
  StoredVoucher,
  TimestampToken,
} from '../../core/types.js';
import { daysBetween, parseIsoInstant } from '../../core/time.js';
import {
  enabledLabel,
  findArchiveBucket,
  isObjectLockEnabled,
  missingResourceEvidence,
  readObjectLockRetention,
  resourceSubject,
} from './cfn.js';

/**
 * 国税庁「電子帳簿保存法関係」の公開ページ。
 *
 * 本実装は要件名で参照するに留め、条文番号は引用しない（誤引用を避ける）。
 */
const NTA_DENCHO_REFERENCE = 'https://www.nta.go.jp/law/joho-zeikaishaku/sonota/031227/index.htm';

/** チェーンの破損理由を日本語で表したラベル。 */
const BREAK_REASON_LABELS: Readonly<Record<ChainBreakReason, string>> = {
  'entry-hash-mismatch': 'エントリハッシュの不一致（改ざんの疑い）',
  'chain-link-mismatch': 'チェーンリンクの不一致（削除・並べ替えの疑い）',
  'content-mismatch': '証憑データのハッシュ不一致（改ざんの疑い）',
  'metadata-mismatch': 'メタデータのハッシュ不一致（改ざんの疑い）',
  'object-missing': '保存オブジェクトの欠落',
  'timestamp-mismatch': 'タイムスタンプの検証失敗',
};

/** 検索要件の 3 項目の日本語ラベル。 */
const SEARCH_FIELD_LABELS: Readonly<Record<SearchField, string>> = {
  transactionDate: '取引年月日',
  amount: '取引金額',
  counterparty: '取引先',
};

/** 検索要件で必須となる 3 項目。 */
const REQUIRED_SEARCH_FIELDS: readonly SearchField[] = ['transactionDate', 'amount', 'counterparty'];

/** タイムスタンプ付与済みの証憑と、そのトークンの組。 */
interface StampedVoucherEntry {
  readonly voucher: StoredVoucher;
  readonly timestamp: TimestampToken;
}

/** タイムスタンプ付与済みの証憑だけを取り出す（未付与は AUTH-01 の担当）。 */
function stampedVouchers(vouchers: readonly StoredVoucher[]): readonly StampedVoucherEntry[] {
  const entries: StampedVoucherEntry[] = [];
  for (const voucher of vouchers) {
    if (voucher.timestamp !== null) {
      entries.push({ voucher, timestamp: voucher.timestamp });
    }
  }
  return entries;
}

/** ハッシュを証跡用に短縮表示する。 */
function shortHash(hash: Sha256Hex | null | undefined): string {
  if (hash === null || hash === undefined) {
    return '（なし）';
  }
  return `${hash.slice(0, 12)}…`;
}

/**
 * AUTH-01: 全証憑にタイムスタンプが付与されている。
 *
 * 設定 `requireTimestamp` が false の場合はタイムスタンプ方式を必須としない
 * 運用であるため `not-applicable` とする（真実性は他の方式で確保する想定）。
 */
const AUTH_01: ComplianceRule = {
  id: 'AUTH-01',
  title: '全証憑にタイムスタンプが付与されている',
  category: 'authenticity',
  severity: 'mandatory',
  description:
    '保存されているすべての証憑に、付与時刻を証明するタイムスタンプトークンが付いているかを確認します。',
  reference: NTA_DENCHO_REFERENCE,
  evaluate(context: RuleContext): RuleEvaluation {
    const vouchers = context.archive.vouchers;
    const missing = vouchers.filter((voucher) => voucher.timestamp === null);
    const stampedCount = vouchers.length - missing.length;
    const evidence: EvidenceItem[] = [
      {
        subject: 'タイムスタンプ付与状況',
        detail: `付与済み ${stampedCount} 件 / 未付与 ${missing.length} 件（対象 ${vouchers.length} 件）`,
        value: `${stampedCount}/${vouchers.length}`,
      },
    ];

    if (vouchers.length === 0) {
      evidence.push({
        subject: '対象証憑',
        detail: '保存されている証憑が 0 件のため、タイムスタンプの付与漏れはありません',
      });
      return { status: 'pass', evidence };
    }

    if (!context.config.requireTimestamp) {
      evidence.push({
        subject: '設定',
        detail:
          'requireTimestamp=false のため、タイムスタンプ方式は必須ではありません（真実性は訂正削除の履歴または WORM で確保する想定）',
      });
      return {
        status: 'not-applicable',
        evidence,
        remediation:
          'タイムスタンプ方式を採用しない場合は、訂正削除の履歴または WORM 保存により真実性を確保し、その運用を証跡として残してください。',
      };
    }

    if (missing.length > 0) {
      evidence.push({
        subject: '未付与の証憑',
        detail: `未付与の voucherId（先頭 5 件）: ${missing
          .slice(0, 5)
          .map((voucher) => voucher.voucherId)
          .join(', ')}`,
        value: missing.length,
      });
      return {
        status: 'fail',
        evidence,
        remediation:
          '取り込み時にタイムスタンプを付与する運用にし、未付与の証憑を再処理してください（全件が付与済みになるまで不適合です）。',
      };
    }

    return { status: 'pass', evidence };
  },
};

/**
 * AUTH-02: タイムスタンプ付与が受領後 62 日以内。
 *
 * 期限日数は設定 `timestampMaxDelayDays` に従う（既定 62 日）。
 * トークン未付与の証憑は AUTH-01 の判定対象であり、ここでは扱わない。
 */
const AUTH_02: ComplianceRule = {
  id: 'AUTH-02',
  title: 'タイムスタンプ付与が受領後 62 日以内',
  category: 'authenticity',
  severity: 'mandatory',
  description:
    'タイムスタンプが、証憑の受領時刻から一定日数（既定 62 日）以内に付与されているかを確認します。',
  reference: NTA_DENCHO_REFERENCE,
  evaluate(context: RuleContext): RuleEvaluation {
    const maxDelayDays = context.config.timestampMaxDelayDays;
    const stamped = stampedVouchers(context.archive.vouchers);
    const evidence: EvidenceItem[] = [
      {
        subject: '付与期限',
        detail: `受領から ${maxDelayDays} 日以内（設定値 timestampMaxDelayDays）`,
        value: maxDelayDays,
      },
    ];

    if (stamped.length === 0) {
      evidence.push({
        subject: '判定対象',
        detail:
          'タイムスタンプ付与済みの証憑が無いため、付与遅延の判定対象はありません（付与漏れは AUTH-01 を参照）',
      });
      return { status: 'pass', evidence };
    }

    const violations: EvidenceItem[] = [];
    let maxObservedDelayDays = 0;
    for (const entry of stamped) {
      let delayDays: number;
      try {
        delayDays = daysBetween(
          parseIsoInstant(entry.voucher.receivedAt),
          parseIsoInstant(entry.timestamp.generatedAt),
        );
      } catch {
        violations.push({
          subject: entry.voucher.voucherId,
          detail: `${entry.voucher.voucherId}: 受領時刻またはタイムスタンプ時刻の形式が不正なため、付与期限を判定できません`,
        });
        continue;
      }

      if (delayDays > maxObservedDelayDays) {
        maxObservedDelayDays = delayDays;
      }
      if (delayDays < 0) {
        violations.push({
          subject: entry.voucher.voucherId,
          detail: `${entry.voucher.voucherId}: タイムスタンプが受領時刻より前に付与されています（${delayDays} 日）`,
          value: delayDays,
        });
      } else if (delayDays > maxDelayDays) {
        violations.push({
          subject: entry.voucher.voucherId,
          detail: `${entry.voucher.voucherId}: 受領から ${delayDays} 日後に付与されています（上限 ${maxDelayDays} 日）`,
          value: delayDays,
        });
      }
    }

    evidence.push({
      subject: '判定対象',
      detail: `タイムスタンプ付与済み ${stamped.length} 件（未付与の証憑は AUTH-01 の判定対象）`,
      value: stamped.length,
    });

    if (violations.length > 0) {
      return {
        status: 'fail',
        evidence: [...evidence, ...violations],
        remediation:
          '受領後おおむね 2 か月以内にタイムスタンプを付与する運用にしてください。受領時刻の記録もあわせて確認してください。',
      };
    }

    evidence.push({
      subject: '付与遅延の最大値',
      detail: `判定対象のうち最大 ${maxObservedDelayDays} 日（上限 ${maxDelayDays} 日）`,
      value: maxObservedDelayDays,
    });
    return { status: 'pass', evidence };
  },
};

/**
 * AUTH-03: タイムスタンプの検証に失敗していない。
 *
 * 台帳検証（`ArchiveView.chain`）がタイムスタンプ検証の失敗を報告したかを確認する。
 * チェーン破損でも理由がタイムスタンプ以外なら、このルールでは pass とする
 * （破損そのものは AUTH-04 が検出する）。
 */
const AUTH_03: ComplianceRule = {
  id: 'AUTH-03',
  title: 'タイムスタンプの検証に失敗していない',
  category: 'authenticity',
  severity: 'mandatory',
  description:
    '保存したタイムスタンプトークンが、対象ダイジェストに対して正当であることを検証できているかを確認します。',
  reference: NTA_DENCHO_REFERENCE,
  evaluate(context: RuleContext): RuleEvaluation {
    const chain = context.archive.chain;
    const breakInfo = chain.break;

    if (breakInfo !== undefined && breakInfo.reason === 'timestamp-mismatch') {
      return {
        status: 'fail',
        evidence: [
          {
            subject: breakInfo.voucherId,
            detail: `タイムスタンプの検証に失敗しました（第 ${breakInfo.sequence} 項）`,
            value: breakInfo.sequence,
          },
          {
            subject: '検証値',
            detail: `期待値: ${shortHash(breakInfo.expected)} / 実際: ${shortHash(breakInfo.actual)}`,
          },
        ],
        remediation:
          'タイムスタンプ局（TSA）の証明書と保存したトークンを確認し、失効・改ざんの有無を調査してください。',
      };
    }

    const evidence: EvidenceItem[] = [];
    if (chain.status === 'empty') {
      evidence.push({
        subject: 'チェーン検証',
        detail: '台帳が空のため、タイムスタンプ検証の対象はありません',
      });
    } else if (breakInfo === undefined) {
      evidence.push({
        subject: 'チェーン検証',
        detail: `タイムスタンプ検証の失敗は検出されていません（検証済み ${chain.checkedEntries} 件）`,
        value: chain.checkedEntries,
      });
    } else {
      evidence.push({
        subject: 'チェーン検証',
        detail: `チェーンの破損理由は「${BREAK_REASON_LABELS[breakInfo.reason]}」であり、タイムスタンプ検証の失敗ではありません`,
      });
    }
    return { status: 'pass', evidence };
  },
};

/**
 * AUTH-04: ハッシュチェーンが整合している。
 *
 * 追記専用台帳のハッシュチェーン（およびチェックポイント）が改ざん・削除・
 * 並べ替えを検出していないかを確認する。空の台帳は「対象なし」として pass。
 */
const AUTH_04: ComplianceRule = {
  id: 'AUTH-04',
  title: 'ハッシュチェーンが整合している',
  category: 'authenticity',
  severity: 'mandatory',
  description:
    '証憑の台帳がハッシュチェーンとして整合しており、エントリの改ざん・削除・並べ替えが検出されないことを確認します。',
  reference: NTA_DENCHO_REFERENCE,
  evaluate(context: RuleContext): RuleEvaluation {
    const chain = context.archive.chain;
    const evidence: EvidenceItem[] = [
      {
        subject: 'ハッシュチェーン',
        detail: `検証済みエントリ数: ${chain.checkedEntries} 件`,
        value: chain.checkedEntries,
      },
      {
        subject: '先頭エントリのハッシュ',
        detail:
          chain.headHash === null
            ? '台帳が空のため、ハッシュはありません'
            : `${shortHash(chain.headHash)}（SHA-256）`,
        value: chain.headHash,
      },
    ];

    const breakInfo = chain.break;
    if (chain.status === 'broken') {
      if (breakInfo !== undefined) {
        evidence.push({
          subject: `第 ${breakInfo.sequence} 項（${breakInfo.voucherId}）`,
          detail: `破損理由: ${BREAK_REASON_LABELS[breakInfo.reason]}（期待値 ${shortHash(
            breakInfo.expected,
          )} / 実際 ${shortHash(breakInfo.actual)}）`,
          value: breakInfo.reason,
        });
      } else {
        evidence.push({
          subject: '破損箇所',
          detail: 'チェーンが破損していますが、破損箇所の詳細が報告されていません',
        });
      }
      return {
        status: 'fail',
        evidence,
        remediation:
          '改ざん・削除の可能性があります。台帳（マニフェスト）と保存データのバックアップを保全したうえで原因を調査し、正しい状態から再構築してください。',
      };
    }

    if (!chain.checkpointsVerified) {
      evidence.push({
        subject: 'チェックポイント',
        detail: 'チェックポイントのハッシュが台帳と一致しません（チェックポイントの改ざんの疑い）',
        value: '不一致',
      });
      return {
        status: 'fail',
        evidence,
        remediation:
          'チェックポイントを台帳から再作成し、署名付きで保存し直してください。',
      };
    }

    evidence.push({
      subject: 'チェックポイント',
      detail: 'チェックポイントは台帳と整合しています',
      value: '整合',
    });
    return { status: 'pass', evidence };
  },
};

/**
 * AUTH-05: WORM または訂正削除履歴による真実性確保（必須・条件付き）。
 *
 * 真実性の確保は「タイムスタンプ」「WORM 保存」「訂正削除の履歴」のいずれかで
 * 確保する。本ルールは、**タイムスタンプ方式を採用していない場合**に残りの手段が
 * 確保されているかを確認する条件付きの必須ルールである。
 *
 * - `requireTimestamp === true`: タイムスタンプ方式を採用済み → `not-applicable`
 *   （真実性は AUTH-01〜AUTH-04 が確認する）
 * - `requireTimestamp === false` かつ `worm === true`: `pass`
 * - `requireTimestamp === false` かつインフラの Object Lock が
 *   `COMPLIANCE` かつ 2557 日以上: `pass`
 * - それ以外: `fail`（真実性の確保手段が無い）
 *
 * 尚、訂正削除の履歴を残す運用は本エンジンでは観測できないため、その方式を採る
 * 場合は設定（`worm` など）と運用証跡で担保する前提としている。
 */
const AUTH_05: ComplianceRule = {
  id: 'AUTH-05',
  title: 'WORM または訂正削除履歴による真実性確保',
  category: 'authenticity',
  severity: 'mandatory',
  description:
    'タイムスタンプ方式を採用しない場合に、保存先が WORM（書き込み後変更不可）であるか、訂正削除の履歴を残す運用かを確認します。タイムスタンプ方式を採用している場合は対象外です。',
  reference: NTA_DENCHO_REFERENCE,
  evaluate(context: RuleContext): RuleEvaluation {
    const evidence: EvidenceItem[] = [
      {
        subject: 'アーカイブ設定',
        detail: `タイムスタンプ方式: ${enabledLabel(context.config.requireTimestamp)} / WORM 保存: ${enabledLabel(
          context.config.worm,
        )}`,
        value: `requireTimestamp=${String(context.config.requireTimestamp)}, worm=${String(context.config.worm)}`,
      },
    ];

    if (context.config.requireTimestamp) {
      evidence.push({
        subject: '真実性の確保',
        detail:
          'タイムスタンプ方式を採用しているため、このルールは対象外です（真実性は AUTH-01〜AUTH-04 で確認します）',
      });
      return { status: 'not-applicable', evidence };
    }

    if (context.config.worm) {
      evidence.push({
        subject: '真実性の確保',
        detail: 'WORM（書き込み後変更不可）の保存先で運用しています',
      });
      return { status: 'pass', evidence };
    }

    if (context.infra !== undefined) {
      const bucket = findArchiveBucket(context.infra);
      if (bucket === undefined) {
        evidence.push(
          missingResourceEvidence('AWS::S3::Bucket', 'WORM（Object Lock）設定を確認できるアーカイブ用バケット'),
        );
      } else {
        const objectLock = isObjectLockEnabled(bucket);
        const retention = readObjectLockRetention(bucket);
        const confirmed =
          objectLock &&
          retention?.mode === 'COMPLIANCE' &&
          retention.days !== undefined &&
          retention.days >= 2557;
        evidence.push({
          subject: resourceSubject(bucket),
          detail: `S3 Object Lock: ${enabledLabel(objectLock)} / 保持モード: ${
            retention?.mode ?? '未設定'
          } / 保持日数: ${retention?.days === undefined ? '未設定' : `${retention.days} 日`}`,
          value: retention?.days ?? null,
        });
        if (confirmed) {
          evidence.push({
            subject: '真実性の確保',
            detail:
              'インフラ定義上、S3 Object Lock（COMPLIANCE / 2557 日以上）により WORM が有効です',
          });
          return { status: 'pass', evidence };
        }
      }
    } else {
      evidence.push({
        subject: 'インフラ定義',
        detail: 'インフラ定義が提供されていないため、クラウド側の WORM 設定は確認できません',
      });
    }

    return {
      status: 'fail',
      evidence,
      remediation:
        'タイムスタンプの付与 / WORM 保存（S3 Object Lock の COMPLIANCE モード）/ 訂正削除の履歴のいずれかを採用し、真実性を確保してください。',
    };
  },
};

/**
 * VIS-01: 検索対象 3 項目が索引化されている（必須）。
 *
 * 取引年月日・取引金額・取引先のすべてが検索可能であることを確認する。
 */
const VIS_01: ComplianceRule = {
  id: 'VIS-01',
  title: '検索対象3項目が索引化されている',
  category: 'visibility',
  severity: 'mandatory',
  description:
    '税務調査等の検索要件で求められる取引年月日・取引金額・取引先の 3 項目が、索引化されて検索できるかを確認します。',
  reference: NTA_DENCHO_REFERENCE,
  evaluate(context: RuleContext): RuleEvaluation {
    const capability = context.archive.capability;
    const available = new Set<SearchField>(capability.searchableFields);
    const missing = REQUIRED_SEARCH_FIELDS.filter((field) => !available.has(field));
    const evidence: EvidenceItem[] = [
      {
        subject: '検索可能項目',
        detail: `索引化済み: ${
          REQUIRED_SEARCH_FIELDS.filter((field) => available.has(field))
            .map((field) => SEARCH_FIELD_LABELS[field])
            .join('、') || 'なし'
        }`,
        value: capability.searchableFields.length,
      },
      {
        subject: '不足している項目',
        detail:
          missing.length === 0
            ? 'なし（取引年月日・取引金額・取引先の 3 項目すべてが索引化されています）'
            : missing.map((field) => SEARCH_FIELD_LABELS[field]).join('、'),
        value: missing.length,
      },
      {
        subject: '索引',
        detail: `定義されている索引: ${capability.indexes.length} 種`,
        value: capability.indexes.length,
      },
    ];

    if (missing.length > 0) {
      return {
        status: 'fail',
        evidence,
        remediation:
          '取引年月日・取引金額・取引先の 3 項目すべてを索引化し、検索できるようにしてください。',
      };
    }
    return { status: 'pass', evidence };
  },
};

/**
 * VIS-02: 2 項目以上の組み合わせ検索が可能（必須）。
 *
 * 電帳法の検索要件は「任意の 2 項目以上の組み合わせ」での検索を求める。
 * ここでは組み合わせ検索の対応が 1 つ以上あることを確認し、期待値 3 件との差を証跡に残す。
 */
const VIS_02: ComplianceRule = {
  id: 'VIS-02',
  title: '2項目以上の組み合わせ検索が可能',
  category: 'visibility',
  severity: 'mandatory',
  description:
    '取引年月日・取引金額・取引先のうち任意の 2 項目以上を組み合わせた検索ができるかを確認します。',
  reference: NTA_DENCHO_REFERENCE,
  evaluate(context: RuleContext): RuleEvaluation {
    const combinations = context.archive.capability.twoFieldCombinations;
    const evidence: EvidenceItem[] = [
      {
        subject: '組み合わせ検索',
        detail:
          combinations.length === 0
            ? '2 項目以上の組み合わせ検索に対応していません'
            : `対応している組み合わせ: ${combinations.join('、')}`,
        value: combinations.length,
      },
      {
        subject: '期待値',
        detail: '任意の 2 項目以上の組み合わせ（3 項目の場合は 3 通り）',
        value: 3,
      },
    ];

    if (combinations.length === 0) {
      return {
        status: 'fail',
        evidence,
        remediation:
          '取引年月日・取引金額・取引先の任意の 2 項目以上を組み合わせた検索を実装してください。',
      };
    }
    return { status: 'pass', evidence };
  },
};

/**
 * VIS-03: 日付・金額の範囲指定検索が可能（必須）。
 */
const VIS_03: ComplianceRule = {
  id: 'VIS-03',
  title: '日付・金額の範囲指定検索が可能',
  category: 'visibility',
  severity: 'mandatory',
  description:
    '取引年月日と取引金額について、範囲（以上・以下）を指定した検索ができるかを確認します。',
  reference: NTA_DENCHO_REFERENCE,
  evaluate(context: RuleContext): RuleEvaluation {
    const capability = context.archive.capability;
    const evidence: EvidenceItem[] = [
      {
        subject: '取引年月日の範囲指定',
        detail: `範囲指定検索: ${enabledLabel(capability.supportsDateRange)}`,
        value: capability.supportsDateRange ? '有効' : '無効',
      },
      {
        subject: '取引金額の範囲指定',
        detail: `範囲指定検索: ${enabledLabel(capability.supportsAmountRange)}`,
        value: capability.supportsAmountRange ? '有効' : '無効',
      },
      {
        subject: '取引先の検索',
        detail: `取引先検索: ${enabledLabel(capability.supportsCounterparty)}`,
        value: capability.supportsCounterparty ? '有効' : '無効',
      },
    ];

    if (!capability.supportsDateRange || !capability.supportsAmountRange) {
      return {
        status: 'fail',
        evidence,
        remediation:
          '取引年月日と取引金額の両方について、範囲（から・まで）を指定した検索を実装してください。',
      };
    }
    return { status: 'pass', evidence };
  },
};

/**
 * RET-01: 保存期間が 7 年以上（必須）。
 *
 * アーカイブ設定の保存年数が 7 年以上であること。インフラ定義が提供されて
 * いる場合は、S3 Object Lock のデフォルト保持が 2557 日（7 年相当）以上で
 * あることも確認する。
 */
const RET_01: ComplianceRule = {
  id: 'RET-01',
  title: '保存期間が7年以上',
  category: 'retention',
  severity: 'mandatory',
  description:
    '証憑の保存期間が 7 年以上に設定され、インフラ側でも S3 Object Lock により 7 年相当（2557 日）以上保持されるかを確認します。',
  reference: NTA_DENCHO_REFERENCE,
  evaluate(context: RuleContext): RuleEvaluation {
    const years = context.config.retentionYears;
    const evidence: EvidenceItem[] = [
      {
        subject: 'アーカイブ設定',
        detail: `保存期間の設定: ${years} 年（法定: 7 年以上）`,
        value: years,
      },
    ];
    let compliant = years >= 7;

    if (context.infra !== undefined) {
      const bucket = findArchiveBucket(context.infra);
      if (bucket === undefined) {
        evidence.push(
          missingResourceEvidence('AWS::S3::Bucket', 'S3 Object Lock の保持期間を確認できるアーカイブ用バケット'),
        );
        compliant = false;
      } else {
        const retention = readObjectLockRetention(bucket);
        if (retention === undefined) {
          evidence.push({
            subject: resourceSubject(bucket),
            detail:
              'Object Lock のデフォルト保持設定（ObjectLockConfiguration.Rule.DefaultRetention）が見つかりません',
          });
          compliant = false;
        } else {
          const enoughDays = retention.days !== undefined && retention.days >= 2557;
          evidence.push({
            subject: resourceSubject(bucket),
            detail: `Object Lock 保持: モード ${retention.mode ?? '未設定'} / ${
              retention.days === undefined ? '日数未設定' : `${retention.days} 日`
            }（要件: 2557 日以上）`,
            value: retention.days ?? null,
          });
          if (!enoughDays) {
            compliant = false;
          }
        }
      }
    } else {
      evidence.push({
        subject: 'インフラ定義',
        detail:
          'インフラ定義が提供されていないため、クラウド側の保持期間は確認していません（アーカイブ設定のみで判定）',
      });
    }

    if (!compliant) {
      return {
        status: 'fail',
        evidence,
        remediation:
          'アーカイブ設定を 7 年以上にし、S3 Object Lock のデフォルト保持を 2557 日以上の COMPLIANCE モードに設定してください。',
      };
    }
    return { status: 'pass', evidence };
  },
};

/**
 * DL-01: 税務調査の「ダウンロードの求め」に対応できる（必須）。
 *
 * 税務調査で求められる CSV / JSON 形式でのダウンロード出力に対応しているかを確認する。
 */
const DL_01: ComplianceRule = {
  id: 'DL-01',
  title: '税務調査の「ダウンロードの求め」に対応できる',
  category: 'tax-audit-support',
  severity: 'mandatory',
  description:
    '税務調査等において「ダウンロードの求め」があった場合に、CSV および JSON 形式で証憑情報を出力できるかを確認します。',
  reference: NTA_DENCHO_REFERENCE,
  evaluate(context: RuleContext): RuleEvaluation {
    const formats = context.archive.capability.exportFormats;
    const hasCsv = formats.includes('csv');
    const hasJson = formats.includes('json');
    const evidence: EvidenceItem[] = [
      {
        subject: '出力形式',
        detail: `対応している出力形式: ${formats.length === 0 ? 'なし' : formats.join(', ')}`,
        value: formats.length,
      },
      {
        subject: 'CSV 出力',
        detail: `CSV 形式のダウンロード: ${enabledLabel(hasCsv)}`,
        value: hasCsv ? '有効' : '無効',
      },
      {
        subject: 'JSON 出力',
        detail: `JSON 形式のダウンロード: ${enabledLabel(hasJson)}`,
        value: hasJson ? '有効' : '無効',
      },
    ];

    if (!hasCsv || !hasJson) {
      return {
        status: 'fail',
        evidence,
        remediation:
          '税務調査の「ダウンロードの求め」に備え、CSV と JSON の両形式で出力できるようにしてください。',
      };
    }
    return { status: 'pass', evidence };
  },
};

/**
 * アーカイブ（保存済みデータ）系のビルトインルール。
 *
 * 並び順はレポートの表示順であり、そのまま `BUILTIN_RULES` の先頭部分になる。
 */
export const ARCHIVE_RULES: readonly ComplianceRule[] = [
  AUTH_01,
  AUTH_02,
  AUTH_03,
  AUTH_04,
  AUTH_05,
  VIS_01,
  VIS_02,
  VIS_03,
  RET_01,
  DL_01,
];
