/**
 * アーカイブのユースケース実装（ファサード）。
 *
 * コア（純粋ロジック）とアダプタ（I/O）を組み合わせ、CLI と Lambda が
 * 共通で使う操作一式を提供する。ここだけが「全体を組み立てる」層であり、
 * 各モジュールは互いを知らないままテストできる。
 *
 * 取り込みの流れ:
 *   1. 入力検証（検索要件を満たす項目が揃っているか）
 *   2. 内容アドレスで本体を保存
 *   3. タイムスタンプ付与（真実性の確保）
 *   4. ハッシュチェーンへ追記（楽観的排他制御つき）
 *   5. 検索索引へ登録
 *
 * 4 と 5 は不可分ではない。索引の登録に失敗しても台帳は正しく、
 * `reindex()` で台帳から索引を再構築できる（障害復旧の設計）。
 */
import { createLedgerEntry, GENESIS_PREVIOUS_HASH, verifyLedger } from '../core/chain.js';
import { IntegrityError, ConflictError, NotFoundError } from '../core/errors.js';
import { renderExport } from '../core/export.js';
import { canonicalBytes } from '../core/canonical.js';
import {
  composeAttestationDigest,
  hashTimestampToken,
  metadataKeyFor,
  objectKeyFor,
  sha256HexBytes,
  sha256HexOf,
} from '../core/hash.js';
import { deriveIndexEntries, toIndexRecord } from '../core/index-keys.js';
import { describeSearchCapability, executeQuery, planQuery, validateQuery } from '../core/query.js';
import { formatIsoInstant, parseIsoInstant } from '../core/time.js';
import { buildAuditReport, evaluateRules } from '../compliance/index.js';
import type {
  Archive,
  ArchiveDependencies,
  ArchiveView,
  AuditReport,
  ChainVerification,
  ExportRequest,
  ExportResult,
  IngestResult,
  InfraSnapshot,
  LedgerEntry,
  QueryPlan,
  SearchCapability,
  StoredMetadata,
  StoredVoucher,
  VoucherQuery,
} from '../core/types.js';
import { toStoredVoucher, buildVoucherMetadata, validateArchiveConfig, validateVoucherInput } from './metadata.js';

/** 台帳追記の競合時に再試行する回数。 */
export const MAX_APPEND_ATTEMPTS = 5;

/** アーカイブを組み立てる。依存はすべて注入する（テストで差し替え可能）。 */
export function createArchive(deps: ArchiveDependencies): Archive {
  validateArchiveConfig(deps.config);

  /** メタデータ封筒を読み出す。 */
  const loadEnvelope = async (entry: LedgerEntry): Promise<StoredMetadata> => {
    const bytes = await deps.blobs.get(metadataKeyFor(entry.metadataSha256));
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as StoredMetadata;
    if (parsed.schemaVersion !== 1) {
      throw new IntegrityError(`未対応のメタデータ形式です: ${String(parsed.schemaVersion)}`, {
        voucherId: entry.voucherId,
      });
    }
    return parsed;
  };

  /** 台帳の末尾。空なら null。 */
  const headOf = (entries: readonly LedgerEntry[]): LedgerEntry | null =>
    entries.length === 0 ? null : (entries[entries.length - 1] ?? null);

  const archive: Archive = {
    config: deps.config,

    async ingest(input): Promise<IngestResult> {
      const now = deps.clock.now();
      validateVoucherInput(input, now);

      const contentSha256 = sha256HexBytes(input.content);
      const manifest = await deps.manifest.read();

      // 冪等性: 同じ voucherId の再送は二重登録しない。
      const existing = manifest.entries.find((entry) => entry.voucherId === input.voucherId.trim());
      if (existing !== undefined) {
        if (existing.contentSha256 === contentSha256) {
          return { voucher: toStoredVoucher(existing, await loadEnvelope(existing)), idempotent: true };
        }
        throw new ConflictError(
          '同じ voucherId で内容の異なる証憑が既に登録されています。別の voucherId を使ってください',
          { voucherId: input.voucherId, existingSha256: existing.contentSha256, incomingSha256: contentSha256 },
        );
      }

      // 真実性の確保: メタデータ（タイムスタンプを除く）と本体の両方に結びつく
      // ダイジェストに対してタイムスタンプを取る。こうすると、本体だけ・
      // メタデータだけを差し替えても検出できる。
      const metadata = buildVoucherMetadata(input, contentSha256);
      const attestationDigest = composeAttestationDigest(contentSha256, sha256HexOf(metadata));
      // タイムスタンプは「受領時刻より前」になってはならない。時計の分解能や
      // わずかなずれで生成時刻が受領時刻を下回ると、付与期限の判定が
      // 負の日数になり誤検知するため、遅い方の時刻を採用する。
      const receivedAtMs = parseIsoInstant(metadata.receivedAt).getTime();
      const stampAt = new Date(Math.max(now.getTime(), receivedAtMs));
      const timestamp = deps.config.requireTimestamp ? await deps.tsa.stamp(attestationDigest, stampAt) : null;
      const envelope: StoredMetadata = { schemaVersion: 1, metadata, timestamp };
      const envelopeBytes = canonicalBytes(envelope);
      const metadataSha256 = sha256HexBytes(envelopeBytes);

      // 本体とメタデータを内容アドレスで保存する。
      await deps.blobs.put(objectKeyFor(contentSha256), input.content);
      await deps.blobs.put(metadataKeyFor(metadataSha256), envelopeBytes);

      // 台帳へ追記する。競合したら読み直して再試行する。
      const entry = await appendWithRetry(metadata.voucherId, contentSha256, metadataSha256, timestamp);

      // 索引登録は台帳の後。失敗しても台帳は正しいので、索引を再構築して回復する。
      try {
        await deps.index.put(indexEntriesOf(entry, metadata));
      } catch {
        await archive.reindex();
      }

      return { voucher: toStoredVoucher(entry, envelope), idempotent: false };
    },

    async search(query: VoucherQuery): Promise<readonly StoredVoucher[]> {
      validateQuery(query);
      const plan = planQuery(query);
      const records = await executeQuery(query, plan, deps.index);
      if (records.length === 0) {
        return [];
      }
      const manifest = await deps.manifest.read();
      const entriesById = new Map(manifest.entries.map((entry) => [entry.voucherId, entry]));
      const vouchers: StoredVoucher[] = [];
      for (const record of records) {
        const entry = entriesById.get(record.voucherId);
        if (entry === undefined) {
          // 索引にだけ存在するレコードは台帳と不整合。黙って落とさず診断できる形で残す。
          continue;
        }
        vouchers.push(toStoredVoucher(entry, await loadEnvelope(entry)));
      }
      return vouchers;
    },

    plan(query: VoucherQuery): QueryPlan {
      validateQuery(query);
      return planQuery(query);
    },

    async export(request: ExportRequest): Promise<ExportResult> {
      const vouchers = await archive.search(request.query);
      return renderExport({
        format: request.format,
        vouchers,
        archiveId: deps.config.archiveId,
        generatedAt: formatIsoInstant(deps.clock.now()),
      });
    },

    async verifyChain(): Promise<ChainVerification> {
      const manifest = await deps.manifest.read();
      return verifyLedger(manifest, {
        blobs: deps.blobs,
        verifyTimestamp: (token, digest) => deps.tsa.verify(token, digest),
      });
    },

    async audit(options?: { readonly infra?: InfraSnapshot }): Promise<AuditReport> {
      const manifest = await deps.manifest.read();
      const vouchers = await archive.list();
      const chain = await archive.verifyChain();
      const view: ArchiveView = {
        manifest,
        vouchers,
        chain,
        capability: archive.capability(),
      };
      const generatedAt = formatIsoInstant(deps.clock.now());
      const results = await evaluateRules({
        archive: view,
        infra: options?.infra,
        now: generatedAt,
        config: deps.config,
      });
      return buildAuditReport({
        archiveId: deps.config.archiveId,
        generatedAt,
        results,
        scope: {
          vouchers: vouchers.length,
          infraStacks: options?.infra === undefined ? 0 : Object.keys(options.infra.stacks).length,
          checkedEntries: chain.checkedEntries,
        },
      });
    },

    async list(): Promise<readonly StoredVoucher[]> {
      const manifest = await deps.manifest.read();
      const vouchers: StoredVoucher[] = [];
      for (const entry of manifest.entries) {
        vouchers.push(toStoredVoucher(entry, await loadEnvelope(entry)));
      }
      return vouchers;
    },

    async getContent(voucherId: string): Promise<Uint8Array> {
      const manifest = await deps.manifest.read();
      const entry = manifest.entries.find((candidate) => candidate.voucherId === voucherId);
      if (entry === undefined) {
        throw new NotFoundError(`証憑が見つかりません: ${voucherId}`, { voucherId });
      }
      return deps.blobs.get(objectKeyFor(entry.contentSha256));
    },

    capability(): SearchCapability {
      return describeSearchCapability();
    },

    async reindex(): Promise<{ readonly records: number; readonly entries: number }> {
      const manifest = await deps.manifest.read();
      const all: import('../core/types.js').IndexEntry[] = [];
      for (const entry of manifest.entries) {
        const envelope = await loadEnvelope(entry);
        all.push(...indexEntriesOf(entry, envelope.metadata));
      }
      await deps.index.rebuild(all);
      return { records: manifest.entries.length, entries: all.length };
    },
  };

  /** 索引エントリを組み立てる。 */
  function indexEntriesOf(entry: LedgerEntry, metadata: StoredMetadata['metadata']): ReturnType<typeof deriveIndexEntries> {
    const record = toIndexRecord({
      voucherId: entry.voucherId,
      transactionDate: metadata.transactionDate,
      amountYen: metadata.amountYen,
      counterpartyNormalized: metadata.counterpartyNormalized,
      documentType: metadata.documentType,
      sequence: entry.sequence,
    });
    return deriveIndexEntries(record);
  }

  /**
   * 台帳へ 1 件追記する。読み込みと追記の間に別の書き込みがあれば、
   * 先頭が変わったことを検出して読み直す（楽観的排他制御）。
   */
  async function appendWithRetry(
    voucherId: string,
    contentSha256: string,
    metadataSha256: string,
    timestamp: StoredMetadata['timestamp'],
  ): Promise<LedgerEntry> {
    for (let attempt = 1; attempt <= MAX_APPEND_ATTEMPTS; attempt += 1) {
      const current = await deps.manifest.read();
      const head = headOf(current.entries);
      const candidate = createLedgerEntry({
        sequence: head === null ? 1 : head.sequence + 1,
        voucherId,
        objectKey: objectKeyFor(contentSha256),
        contentSha256,
        metadataSha256,
        timestampSha256: hashTimestampToken(timestamp),
        recordedAt: formatIsoInstant(deps.clock.now()),
        previousEntryHash: head === null ? GENESIS_PREVIOUS_HASH : head.entryHash,
      });

      try {
        await deps.manifest.append(candidate, {
          sequence: head === null ? 0 : head.sequence,
          entryHash: head === null ? null : head.entryHash,
        });
        return candidate;
      } catch (error) {
        if (error instanceof Error && error.name === 'ChainConflictError' && attempt < MAX_APPEND_ATTEMPTS) {
          continue;
        }
        throw error;
      }
    }
    throw new IntegrityError('台帳への追記が競合し続けました。時間をおいて再試行してください', { voucherId });
  }

  return archive;
}
