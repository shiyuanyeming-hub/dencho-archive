/**
 * ローカル実行用のアーカイブ組み立て。
 *
 * この実装は AWS を使わずに、実ファイルシステム上でアーカイブを再現する。
 * デモ・CLI・テストはこのファクトリを使うため、同じアプリケーションコードが
 * ローカルでも Lambda 上でも動く（ポート & アダプタ構成）ことが確認できる。
 *
 * 保存レイアウト:
 *   <rootDir>/manifest.json   台帳（ハッシュチェーン）
 *   <rootDir>/index.json      検索索引
 *   <rootDir>/blobs/...       内容アドレスで保存された本体・メタデータ
 */
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Archive, ArchiveConfig, Clock, TimestampAuthority } from '../core/types.js';
import { createLocalTimestampAuthority } from '../core/timestamp.js';
import { FixedClock, SystemClock } from '../core/time.js';
import { LocalBlobStore } from '../adapters/local/blob-store.js';
import { createArchiveManifest, LocalManifestStore } from '../adapters/local/manifest-store.js';
import { LocalIndexStore } from '../adapters/local/index-store.js';
import { createArchive } from './archive.js';
import { DEFAULT_ARCHIVE_CONFIG } from './metadata.js';
import { formatIsoInstant } from '../core/time.js';

/** ローカルアーカイブの作成オプション。 */
export interface LocalArchiveOptions {
  /** アーカイブのルートディレクトリ。 */
  readonly rootDir: string;
  /** アーカイブ ID（既定は `local-archive`）。 */
  readonly archiveId?: string;
  /** 時刻源（テスト・デモでは固定クロックを渡す）。 */
  readonly clock?: Clock;
  /** タイムスタンプ局（テストでは決定的な実装を渡す）。 */
  readonly tsa?: TimestampAuthority;
  /** 既定設定の上書き。 */
  readonly config?: Partial<Omit<ArchiveConfig, 'archiveId'>>;
  /** 作成日時（既定は現在時刻）。 */
  readonly createdAt?: string;
  /** 既存のアーカイブを消して作り直す。 */
  readonly reset?: boolean;
  /** TSA の署名鍵（既定は開発用）。 */
  readonly timestampSecret?: string;
}

/** アーカイブのファイル配置。 */
export interface LocalArchiveLayout {
  readonly rootDir: string;
  readonly manifestPath: string;
  readonly indexPath: string;
  readonly blobsDir: string;
}

/** ローカルアーカイブのパスを組み立てる。 */
export function localArchiveLayout(rootDir: string): LocalArchiveLayout {
  const resolved = path.resolve(rootDir);
  return {
    rootDir: resolved,
    manifestPath: path.join(resolved, 'manifest.json'),
    indexPath: path.join(resolved, 'index.json'),
    blobsDir: path.join(resolved, 'blobs'),
  };
}

/** 指定パスにアーカイブが既に存在するか。 */
export async function localArchiveExists(rootDir: string): Promise<boolean> {
  try {
    const info = await stat(localArchiveLayout(rootDir).manifestPath);
    return info.isFile();
  } catch {
    return false;
  }
}

/**
 * ローカルアーカイブを作る（既存なら開く）。
 *
 * `reset: true` を指定すると既存データを削除する。デモはこれを利用して
 * 毎回同じ状態から開始する。
 */
export async function createLocalArchive(options: LocalArchiveOptions): Promise<Archive> {
  const layout = localArchiveLayout(options.rootDir);
  if (options.reset === true) {
    await rm(layout.rootDir, { recursive: true, force: true });
  }
  await mkdir(layout.blobsDir, { recursive: true });

  const clock = options.clock ?? new SystemClock();
  const config: ArchiveConfig = {
    archiveId: options.archiveId ?? 'local-archive',
    retentionYears: options.config?.retentionYears ?? DEFAULT_ARCHIVE_CONFIG.retentionYears,
    timestampMaxDelayDays:
      options.config?.timestampMaxDelayDays ?? DEFAULT_ARCHIVE_CONFIG.timestampMaxDelayDays,
    worm: options.config?.worm ?? DEFAULT_ARCHIVE_CONFIG.worm,
    requireTimestamp: options.config?.requireTimestamp ?? DEFAULT_ARCHIVE_CONFIG.requireTimestamp,
  };
  const tsa = options.tsa ?? createLocalTimestampAuthority(clock, options.timestampSecret);
  const initialManifest = createArchiveManifest({
    archiveId: config.archiveId,
    createdAt: options.createdAt ?? formatIsoInstant(clock.now()),
    retentionYears: config.retentionYears,
    worm: config.worm,
  });
  // 初回作成時はマニフェストを実ファイルとして書き出す（init 直後に読めるようにする）。
  if (!(await fileExists(layout.manifestPath))) {
    await writeFile(layout.manifestPath, `${JSON.stringify(initialManifest, null, 2)}\n`, 'utf8');
  }
  const manifestStore = new LocalManifestStore(layout.manifestPath);

  return createArchive({
    config,
    blobs: new LocalBlobStore(layout.blobsDir),
    manifest: manifestStore,
    index: new LocalIndexStore(layout.indexPath),
    clock,
    tsa,
  });
}

async function fileExists(target: string): Promise<boolean> {
  try {
    const info = await stat(target);
    return info.isFile();
  } catch {
    return false;
  }
}

/** テスト用の固定クロックを作る（`createLocalArchive` と併用）。 */
export function fixedClock(instant: string): FixedClock {
  return new FixedClock(instant);
}
