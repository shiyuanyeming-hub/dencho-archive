/**
 * dencho-archive の公開型定義。
 *
 * ここに定義した型は、コア（純粋ドメイン）・アダプタ（ローカル/AWS）・
 * CDK（インフラ）・適合性検証エンジンの唯一の境界面である。
 *
 * 設計方針:
 * - コアは AWS SDK に依存しない。I/O はすべてポート（インタフェース）越しに扱う。
 * - 金額は整数の円で持つ（浮動小数を使わない）。検索要件の範囲指定を
 *   ソートキーで表現できるようにするため、エンコード規則は core/index-keys.ts が持つ。
 * - 日付は JST の `YYYY-MM-DD`、時刻はオフセット付き RFC3339 で保持する。
 *   日本には夏時間が無いため JST は固定 +09:00 として扱える。
 */

// ---------------------------------------------------------------------------
// 基本型
// ---------------------------------------------------------------------------

/** JST の日付（`YYYY-MM-DD`）。 */
export type IsoDate = string;

/** オフセット付き RFC3339 の時刻（例: `2026-10-31T18:30:00+09:00`）。 */
export type IsoInstant = string;

/** SHA-256 の 16 進表現（64 文字）。 */
export type Sha256Hex = string;

/** 証憑の種類。電帳法の対象となる書類区分に対応する。 */
export type DocumentType =
  | 'invoice' // 請求書
  | 'receipt' // 領収書
  | 'delivery-note' // 納品書
  | 'contract' // 契約書
  | 'order' // 注文書
  | 'statement' // 明細書
  | 'other';

/** 検索要件で求められる 3 項目。 */
export type SearchField = 'transactionDate' | 'amount' | 'counterparty';

/** 索引の名前。DynamoDB のテーブル/GSI に対応する。 */
export type IndexName =
  | 'by-date' // 取引年月日
  | 'by-amount' // 取引金額
  | 'by-counterparty' // 取引先
  | 'by-counterparty-date' // 取引先 + 取引年月日
  | 'by-counterparty-amount'; // 取引先 + 取引金額

/** 税務調査（「ダウンロードの求め」）に応えるための出力形式。 */
export type ExportFormat = 'csv' | 'json';

/** 電帳法の要件カテゴリ。 */
export type RequirementCategory =
  | 'authenticity' // 真実性の確保
  | 'visibility' // 可視性の確保
  | 'searchability' // 検索要件
  | 'retention' // 保存期間
  | 'tax-audit-support' // 税務調査対応（ダウンロードの求め）
  | 'auditability'; // 監査証跡

/** 適合性ルールの重要度。`mandatory` は法令上必須、`recommended` は推奨。 */
export type RuleSeverity = 'mandatory' | 'recommended';

/** ルールの判定結果。 */
export type RuleStatus = 'pass' | 'fail' | 'not-applicable' | 'error';

/** ハッシュチェーン検証の結果区分。 */
export type ChainStatus = 'intact' | 'broken' | 'empty';

/** チェーンが壊れた理由。 */
export type ChainBreakReason =
  | 'entry-hash-mismatch' // エントリのハッシュが再計算値と一致しない（改ざん）
  | 'chain-link-mismatch' // previousEntryHash が直前エントリと繋がらない（削除・並べ替え）
  | 'content-mismatch' // 証憑データが保存時のハッシュと一致しない
  | 'metadata-mismatch' // メタデータが保存時のハッシュと一致しない
  | 'object-missing' // 保存されているはずのオブジェクトが無い
  | 'timestamp-mismatch'; // タイムスタンプの検証に失敗した

// ---------------------------------------------------------------------------
// 証憑（入力）
// ---------------------------------------------------------------------------

/** 取引先。 */
export interface Counterparty {
  /** 表示名（例: `株式会社サンプル商事`）。 */
  readonly name: string;
  /** 適格請求書発行事業者の登録番号（`T` + 13 桁）。無い場合は省略。 */
  readonly invoiceRegistrationNumber?: string;
}

/** アーカイブへ取り込む証憑データ。 */
export interface VoucherInput {
  /**
   * 取引先が発行する伝票番号など、事業者内で一意な識別子。
   * 取り込みの冪等性キーとして使う（同じ ID の再送は二重登録しない）。
   */
  readonly voucherId: string;
  /** 取引年月日（JST）。 */
  readonly transactionDate: IsoDate;
  /** 取引金額（税込・整数円）。 */
  readonly amountYen: number;
  readonly counterparty: Counterparty;
  readonly documentType: DocumentType;
  /** 元ファイル名（表示用。パスは含めない）。 */
  readonly originalFileName: string;
  readonly mediaType: string;
  /** 証憑データ本体。 */
  readonly content: Uint8Array;
  /** データを受領した時刻。タイムスタンプの付与期限の判定に使う。 */
  readonly receivedAt: IsoInstant;
  readonly tags?: readonly string[];
  readonly note?: string;
}

/** 取り込み結果。 */
export interface IngestResult {
  readonly voucher: StoredVoucher;
  /** 既に同じ証憑が保存されていた（再送）場合 true。 */
  readonly idempotent: boolean;
}

// ---------------------------------------------------------------------------
// タイムスタンプ
// ---------------------------------------------------------------------------

/**
 * タイムスタンプトークン。
 *
 * 実運用では RFC 3161 のタイムスタンプ応答（TSA が署名した時刻証明）を
 * 保存する。本プロジェクトのローカル実装は HMAC による検証可能な
 * トークンで、構造と検証フローを再現する（法的な時刻証明ではない）。
 */
export interface TimestampToken {
  /** TSA（時刻認証局）の識別子。 */
  readonly authority: string;
  /** トークンの一意な通し番号。 */
  readonly serial: string;
  readonly digestAlgorithm: 'sha256';
  /** タイムスタンプ対象のダイジェスト（16 進）。 */
  readonly digest: Sha256Hex;
  /** 時刻証明の生成時刻（genTime）。 */
  readonly generatedAt: IsoInstant;
  /** 署名（実運用は TSA の電子署名、ローカルは HMAC）。 */
  readonly signature: string;
}

/** タイムスタンプを付与する主体（ポート）。 */
export interface TimestampAuthority {
  readonly id: string;
  /** `digest` に対する時刻証明を発行する。`at` を省略すると実装の時計を使う。 */
  stamp(digest: Sha256Hex, at?: Date): Promise<TimestampToken>;
  /** トークンが `digest` に対する正当な時刻証明かを検証する。 */
  verify(token: TimestampToken, digest: Sha256Hex): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// 保存済みの証憑
// ---------------------------------------------------------------------------

/** 正規化済みメタデータ。ハッシュチェーンの一部として内容が固定される。 */
export interface VoucherMetadata {
  readonly schemaVersion: 1;
  readonly voucherId: string;
  readonly transactionDate: IsoDate;
  readonly amountYen: number;
  readonly counterpartyName: string;
  /** 検索用に正規化した取引先名（全半角・空白・法人格表記を揃える）。 */
  readonly counterpartyNormalized: string;
  readonly invoiceRegistrationNumber: string | null;
  readonly documentType: DocumentType;
  readonly originalFileName: string;
  readonly mediaType: string;
  /** 証憑データ本体の SHA-256。メタデータと本体を結びつける。 */
  readonly contentSha256: Sha256Hex;
  readonly contentBytes: number;
  readonly receivedAt: IsoInstant;
  readonly tags: readonly string[];
  readonly note: string | null;
}

/**
 * メタデータブロブの封筒。
 *
 * メタデータ本体とタイムスタンプトークンを 1 つのオブジェクトとして保存する。
 * こうすると「メタデータのハッシュ」がトークンも含めて固定され、
 * チェーン上の `metadataSha256` 1 つで両方の完全性を検証できる。
 */
export interface StoredMetadata {
  readonly schemaVersion: 1;
  readonly metadata: VoucherMetadata;
  readonly timestamp: TimestampToken | null;
}

/** アーカイブに保存された証憑のビュー。 */
export interface StoredVoucher {
  readonly voucherId: string;
  /** チェーン上の位置（1 始まり）。 */
  readonly sequence: number;
  readonly transactionDate: IsoDate;
  readonly amountYen: number;
  readonly counterpartyName: string;
  readonly counterpartyNormalized: string;
  readonly documentType: DocumentType;
  readonly originalFileName: string;
  readonly mediaType: string;
  /** 本体を保存したキー（内容アドレス）。 */
  readonly objectKey: string;
  readonly contentSha256: Sha256Hex;
  readonly metadataSha256: Sha256Hex;
  /** チェーン上のエントリハッシュ。 */
  readonly entryHash: Sha256Hex;
  readonly recordedAt: IsoInstant;
  readonly receivedAt: IsoInstant;
  readonly timestamp: TimestampToken | null;
  readonly tags: readonly string[];
  readonly note: string | null;
}

// ---------------------------------------------------------------------------
// ハッシュチェーン
// ---------------------------------------------------------------------------

/**
 * 追記専用台帳の 1 エントリ。
 *
 * `entryHash` は自分自身の内容（このオブジェクト）と直前エントリのハッシュに
 * 対する SHA-256 であり、1 件でも改ざん・削除・並べ替えが起きると
 * 以降のハッシュがすべて食い違う（改ざん検知）。
 */
export interface LedgerEntry {
  /** 1 始まりの通し番号。 */
  readonly sequence: number;
  readonly voucherId: string;
  /** 証憑データのキー（内容アドレス）。 */
  readonly objectKey: string;
  readonly contentSha256: Sha256Hex;
  readonly metadataSha256: Sha256Hex;
  /** タイムスタンプトークンのハッシュ（未付与なら null）。 */
  readonly timestampSha256: Sha256Hex | null;
  readonly recordedAt: IsoInstant;
  /** 直前エントリのハッシュ。先頭は 64 個の `0`。 */
  readonly previousEntryHash: Sha256Hex;
  readonly entryHash: Sha256Hex;
}

/** チェーンの先頭を固定するためのチェックポイント。 */
export interface ChainCheckpoint {
  readonly sequence: number;
  readonly entryHash: Sha256Hex;
  readonly recordedAt: IsoInstant;
  /** チェックポイント自体の署名（任意）。 */
  readonly signature?: string;
}

/** アーカイブ全体の台帳。 */
export interface ArchiveManifest {
  readonly schemaVersion: 1;
  readonly archiveId: string;
  readonly createdAt: IsoInstant;
  /** 保存期間（年）。法定は 7 年。 */
  readonly retentionYears: number;
  /** WORM（書き込み後変更不可）の保存先かを示す。 */
  readonly worm: boolean;
  readonly entries: readonly LedgerEntry[];
  readonly checkpoints: readonly ChainCheckpoint[];
}

/** チェーン検証の結果。 */
export interface ChainVerification {
  readonly status: ChainStatus;
  readonly checkedEntries: number;
  /** 壊れている場合はその最初の箇所。 */
  readonly break?: ChainBreak;
  /** 先頭エントリのハッシュ（空なら null）。 */
  readonly headHash: Sha256Hex | null;
  /** チェックポイントとの整合が取れているか。 */
  readonly checkpointsVerified: boolean;
}

/** チェーンの破損箇所。 */
export interface ChainBreak {
  /** 破損が検出されたエントリの位置。 */
  readonly sequence: number;
  readonly reason: ChainBreakReason;
  /** 期待される値（再計算値）。 */
  readonly expected: string;
  /** 実際に保存されていた値。 */
  readonly actual: string;
  readonly voucherId: string;
}

// ---------------------------------------------------------------------------
// 検索
// ---------------------------------------------------------------------------

/** 検索条件。少なくとも 1 つの条件が必要。 */
export interface VoucherQuery {
  readonly dateFrom?: IsoDate;
  readonly dateTo?: IsoDate;
  readonly amountMin?: number;
  readonly amountMax?: number;
  readonly counterparty?: string;
  readonly documentType?: DocumentType;
  readonly limit?: number;
  /** 並び順（既定は取引年月日の降順）。 */
  readonly order?: 'date-desc' | 'date-asc' | 'amount-desc';
}

/** 索引に保存する 1 件分のレコード。 */
export interface IndexRecord {
  readonly voucherId: string;
  readonly transactionDate: IsoDate;
  readonly amountYen: number;
  readonly counterpartyNormalized: string;
  readonly documentType: DocumentType;
  readonly sequence: number;
}

/** 索引の 1 エントリ（パーティションキー + ソートキー + レコード）。 */
export interface IndexEntry {
  readonly index: IndexName;
  readonly partitionKey: string;
  readonly sortKey: string;
  readonly record: IndexRecord;
}

/** 索引へのクエリ（DynamoDB の Query に相当する単一アクセス）。 */
export interface IndexQuery {
  readonly index: IndexName;
  readonly partitionKey: string;
  /** ソートキーの下限（含む）。 */
  readonly sortKeyFrom?: string;
  /** ソートキーの上限（含む）。 */
  readonly sortKeyTo?: string;
}

/** 検索計画。どの索引をどう引くかを決めた結果。 */
export interface QueryPlan {
  readonly accesses: readonly IndexQuery[];
  /** 索引で絞り込めず、取得後に適用する残条件。 */
  readonly residual: QueryResidual;
  /** 何回の索引アクセスで済むか（見積り）。 */
  readonly estimatedAccesses: number;
  /** なぜこの計画を選んだかの説明（レポート・デバッグ用）。 */
  readonly rationale: string;
}

/** 索引で表現できない残条件。 */
export interface QueryResidual {
  readonly counterparty?: string;
  readonly documentType?: DocumentType;
  readonly amountMin?: number;
  readonly amountMax?: number;
  readonly dateFrom?: IsoDate;
  readonly dateTo?: IsoDate;
}

/** 検索要件の充足状況。適合性検証が参照する。 */
export interface SearchCapability {
  readonly searchableFields: readonly SearchField[];
  readonly supportsDateRange: boolean;
  readonly supportsAmountRange: boolean;
  readonly supportsCounterparty: boolean;
  /** 2 項目以上の組み合わせで検索できる組み合わせ。 */
  readonly twoFieldCombinations: readonly string[];
  readonly exportFormats: readonly ExportFormat[];
  readonly indexes: readonly IndexName[];
}

// ---------------------------------------------------------------------------
// 出力（税務調査のダウンロードの求め）
// ---------------------------------------------------------------------------

export interface ExportRequest {
  readonly format: ExportFormat;
  readonly query: VoucherQuery;
}

export interface ExportResult {
  readonly fileName: string;
  readonly mediaType: string;
  readonly bytes: Uint8Array;
  readonly rowCount: number;
}

// ---------------------------------------------------------------------------
// 適合性検証（コンプライアンス）
// ---------------------------------------------------------------------------

/** 判定の根拠として提示する証跡。 */
export interface EvidenceItem {
  /** 対象（証憑 ID、リソースの論理 ID など）。 */
  readonly subject: string;
  /** 人が読める説明。 */
  readonly detail: string;
  /** 実測値（あれば）。 */
  readonly value?: string | number | null;
}

/** 1 ルールの判定。エンジンがルール定義と合成して `RuleResult` にする。 */
export interface RuleEvaluation {
  readonly status: RuleStatus;
  readonly evidence: readonly EvidenceItem[];
  readonly remediation?: string;
  /** エラー時のメッセージ。 */
  readonly error?: string;
}

/** ルール評価に渡す文脈。 */
export interface RuleContext {
  readonly archive: ArchiveView;
  /** CDK で合成したインフラ定義。未指定ならインフラ系ルールは not-applicable。 */
  readonly infra: InfraSnapshot | undefined;
  /** 判定基準時刻。 */
  readonly now: IsoInstant;
  readonly config: ArchiveConfig;
}

/** 適合性ルールの定義。 */
export interface ComplianceRule {
  readonly id: string;
  readonly title: string;
  readonly category: RequirementCategory;
  readonly severity: RuleSeverity;
  /** 何を確認するルールかの説明。 */
  readonly description: string;
  /** 根拠となる公的資料への参照（URL など）。 */
  readonly reference?: string;
  evaluate(context: RuleContext): RuleEvaluation | Promise<RuleEvaluation>;
}

/** ルール 1 件の最終結果。 */
export interface RuleResult {
  readonly ruleId: string;
  readonly title: string;
  readonly category: RequirementCategory;
  readonly severity: RuleSeverity;
  readonly status: RuleStatus;
  readonly evidence: readonly EvidenceItem[];
  readonly remediation?: string;
  readonly reference?: string;
  readonly error?: string;
}

/** 監査レポートの総合判定。 */
export type AuditVerdict =
  | 'compliant' // 必須ルールがすべて pass
  | 'non-compliant' // 必須ルールに fail がある
  | 'incomplete'; // 評価できなかった必須ルール（error）がある

export interface AuditSummary {
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly notApplicable: number;
  readonly errored: number;
}

export interface AuditReport {
  readonly schemaVersion: 1;
  readonly archiveId: string;
  readonly generatedAt: IsoInstant;
  readonly verdict: AuditVerdict;
  readonly summary: AuditSummary;
  readonly scope: {
    readonly vouchers: number;
    readonly infraStacks: number;
    readonly checkedEntries: number;
  };
  readonly results: readonly RuleResult[];
}

// ---------------------------------------------------------------------------
// インフラ（CDK 合成結果）
// ---------------------------------------------------------------------------

/** CloudFormation のリソース定義（必要な範囲だけを型付けする）。 */
export interface CfnResource {
  readonly Type: string;
  readonly Properties?: Readonly<Record<string, unknown>>;
}

/** CloudFormation テンプレート（必要な範囲だけを型付けする）。 */
export interface CfnTemplate {
  readonly AWSTemplateFormatVersion?: string;
  readonly Resources: Readonly<Record<string, CfnResource>>;
}

/** CDK で合成した全スタックのスナップショット。 */
export interface InfraSnapshot {
  readonly stacks: Readonly<Record<string, CfnTemplate>>;
}

// ---------------------------------------------------------------------------
// アーカイブの公開ビューとポート
// ---------------------------------------------------------------------------

/** 適合性検証が参照する、アーカイブの現在の状態。 */
export interface ArchiveView {
  readonly manifest: ArchiveManifest;
  readonly vouchers: readonly StoredVoucher[];
  readonly chain: ChainVerification;
  readonly capability: SearchCapability;
}

/** 時刻源（テストで固定できるようにする）。 */
export interface Clock {
  now(): Date;
}

/** 証憑データ・メタデータを保存する低レベルストア。 */
export interface BlobStore {
  put(key: string, data: Uint8Array): Promise<void>;
  get(key: string): Promise<Uint8Array>;
  has(key: string): Promise<boolean>;
  list(prefix?: string): Promise<readonly string[]>;
}

/**
 * 台帳（マニフェスト）の保存先。
 *
 * `append` は楽観的排他制御を行う。読み出したときの先頭ハッシュが
 * 変わっていた場合は `ChainConflictError` を投げる（同時書き込みの検出）。
 */
export interface ManifestStore {
  read(): Promise<ArchiveManifest>;
  append(
    entry: LedgerEntry,
    expectHead: { readonly sequence: number; readonly entryHash: Sha256Hex | null },
  ): Promise<void>;
  updateCheckpoints(checkpoints: readonly ChainCheckpoint[]): Promise<void>;
}

/** 検索索引の保存先。 */
export interface IndexStore {
  put(entries: readonly IndexEntry[]): Promise<void>;
  query(query: IndexQuery): Promise<readonly IndexRecord[]>;
  /** 索引を全件入れ替える（再構築用）。 */
  rebuild(entries: readonly IndexEntry[]): Promise<void>;
  /** 分散具合の診断用: 索引ごとのエントリ数。 */
  stats(): Promise<Readonly<Record<IndexName, number>>>;
}

// ---------------------------------------------------------------------------
// 設定
// ---------------------------------------------------------------------------

/** アーカイブの動作設定。 */
export interface ArchiveConfig {
  readonly archiveId: string;
  /** 保存期間（年）。法定は 7 年。 */
  readonly retentionYears: number;
  /**
   * タイムスタンプの付与期限（日）。受領からこの日数を超えて付与された
   * トークンは真実性ルールで fail とする。実務は「受領後おおむね 2 か月」。
   */
  readonly timestampMaxDelayDays: number;
  /** WORM 保存先かどうか（ローカルでは false を許容）。 */
  readonly worm: boolean;
  /** タイムスタンプを必須にするか。 */
  readonly requireTimestamp: boolean;
}

/** アーカイブ操作の依存（テストで差し替え可能にする）。 */
export interface ArchiveDependencies {
  readonly config: ArchiveConfig;
  readonly blobs: BlobStore;
  readonly manifest: ManifestStore;
  readonly index: IndexStore;
  readonly clock: Clock;
  readonly tsa: TimestampAuthority;
}

/** アーカイブの操作一式。CLI と Lambda ハンドラはこのインタフェースだけを使う。 */
export interface Archive {
  readonly config: ArchiveConfig;
  ingest(input: VoucherInput): Promise<IngestResult>;
  /** 取り込み（冪等）。既存ならそのまま返す。 */
  search(query: VoucherQuery): Promise<readonly StoredVoucher[]>;
  /** 検索計画だけを返す（検索要件の説明用）。 */
  plan(query: VoucherQuery): QueryPlan;
  export(request: ExportRequest): Promise<ExportResult>;
  verifyChain(): Promise<ChainVerification>;
  audit(options?: { readonly infra?: InfraSnapshot }): Promise<AuditReport>;
  list(): Promise<readonly StoredVoucher[]>;
  getContent(voucherId: string): Promise<Uint8Array>;
  /** 検索要件の充足状況。 */
  capability(): SearchCapability;
  /** 索引を台帳から再構築する（障害復旧用）。 */
  reindex(): Promise<{ readonly records: number; readonly entries: number }>;
}
