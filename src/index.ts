/**
 * dencho-archive の公開 API。
 *
 * ライブラリとして組み込む場合も、CLI / Lambda として使う場合も、
 * ここが提供する関数だけを知っていればよい。
 *
 * 例:
 * ```ts
 * import { createLocalArchive } from 'dencho-archive';
 * const archive = await createLocalArchive({ rootDir: './archive' });
 * await archive.ingest({ ... });
 * const report = await archive.audit();
 * ```
 */

// アーカイブ（ユースケース）
export { createArchive, MAX_APPEND_ATTEMPTS } from './app/archive.js';
export { createLocalArchive, localArchiveLayout, localArchiveExists, fixedClock } from './app/factory.js';
export type { LocalArchiveOptions, LocalArchiveLayout } from './app/factory.js';
export {
  createAwsArchive,
  awsArchiveFromEnv,
  getAwsArchive,
  resetAwsArchiveCache,
  SEVEN_YEARS_IN_DAYS,
} from './app/aws-factory.js';
export type { AwsArchiveOptions } from './app/aws-factory.js';
export {
  buildVoucherMetadata,
  toStoredVoucher,
  validateArchiveConfig,
  validateVoucherInput,
  DEFAULT_ARCHIVE_CONFIG,
  MAX_AMOUNT_YEN,
  MAX_CONTENT_BYTES,
} from './app/metadata.js';

// コア（純粋ロジック）
export { canonicalJson, canonicalBytes, CanonicalizationError } from './core/canonical.js';
export {
  ZERO_HASH,
  composeAttestationDigest,
  contentKey,
  hashTimestampToken,
  isSha256Hex,
  metadataKeyFor,
  objectKeyFor,
  sha256HexBytes,
  sha256HexOf,
  sha256HexText,
} from './core/hash.js';
export {
  GENESIS_PREVIOUS_HASH,
  computeEntryHash,
  createLedgerEntry,
  verifyLedger,
} from './core/chain.js';
export type { EntryInput, VerifyLedgerOptions } from './core/chain.js';
export {
  INDEX_NAMES,
  amountBucket,
  amountBucketsCovering,
  counterpartyPartition,
  datePartition,
  decodeAmount,
  deriveIndexEntries,
  encodeAmount,
  normalizeCounterparty,
  toIndexRecord,
} from './core/index-keys.js';
export {
  TWO_FIELD_COMBINATIONS,
  describeSearchCapability,
  executeQuery,
  matchesResidual,
  planQuery,
  validateQuery,
} from './core/query.js';
export { renderExport } from './core/export.js';
export type { ExportParams } from './core/export.js';
export {
  FixedClock,
  SystemClock,
  addYears,
  daysBetween,
  formatIsoDate,
  formatIsoInstant,
  isValidIsoDate,
  isValidIsoInstant,
  parseIsoDate,
  parseIsoInstant,
} from './core/time.js';
export {
  DEFAULT_LOCAL_TSA_ID,
  LocalHmacTimestampAuthority,
  createLocalTimestampAuthority,
} from './core/timestamp.js';
export {
  ArchiveError,
  ChainConflictError,
  ConflictError,
  IntegrityError,
  NotFoundError,
  ValidationError,
} from './core/errors.js';

// アダプタ
export { LocalBlobStore } from './adapters/local/blob-store.js';
export { LocalManifestStore, createArchiveManifest } from './adapters/local/manifest-store.js';
export { LocalIndexStore } from './adapters/local/index-store.js';
export { S3BlobStore, DEFAULT_OBJECT_LOCK_MODE } from './adapters/aws/s3-blob-store.js';
export type { S3BlobStoreOptions } from './adapters/aws/s3-blob-store.js';
export { DynamoDbIndexStore } from './adapters/aws/dynamodb-index-store.js';
export type { DynamoDbIndexStoreOptions } from './adapters/aws/dynamodb-index-store.js';
export { DynamoDbManifestStore } from './adapters/aws/dynamodb-manifest-store.js';
export type { DynamoDbManifestStoreOptions } from './adapters/aws/dynamodb-manifest-store.js';

// 適合性監査
export {
  BUILTIN_RULES,
  auditExitCode,
  buildAuditReport,
  evaluateRules,
  evaluateRuleSet,
  renderAuditJson,
  renderAuditMarkdown,
} from './compliance/index.js';
export { ARCHIVE_RULES, INFRA_RULES } from './compliance/rules/index.js';

// インフラ（CDK）
export { buildApp, synthAll } from './cdk/synth.js';
export type { SynthOptions } from './cdk/synth.js';

// 型
export type {
  Archive,
  ArchiveConfig,
  ArchiveDependencies,
  ArchiveManifest,
  ArchiveView,
  AuditReport,
  AuditVerdict,
  BlobStore,
  ChainBreak,
  ChainBreakReason,
  ChainCheckpoint,
  ChainStatus,
  ChainVerification,
  Clock,
  CfnResource,
  CfnTemplate,
  ComplianceRule,
  Counterparty,
  DocumentType,
  EvidenceItem,
  ExportFormat,
  ExportRequest,
  ExportResult,
  IndexEntry,
  IndexName,
  IndexQuery,
  IndexRecord,
  IndexStore,
  InfraSnapshot,
  IngestResult,
  IsoDate,
  IsoInstant,
  LedgerEntry,
  ManifestStore,
  QueryPlan,
  QueryResidual,
  RequirementCategory,
  RuleContext,
  RuleEvaluation,
  RuleResult,
  RuleSeverity,
  RuleStatus,
  SearchCapability,
  SearchField,
  Sha256Hex,
  StoredMetadata,
  StoredVoucher,
  TimestampAuthority,
  TimestampToken,
  VoucherInput,
  VoucherMetadata,
  VoucherQuery,
} from './core/types.js';

// バージョン
export { TOOL_NAME, TOOL_VERSION, ARCHIVE_SCHEMA_VERSION } from './version.js';
