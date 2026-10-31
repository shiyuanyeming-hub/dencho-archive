/**
 * CDK アプリの組み立てと、全スタックのテンプレート合成（オフライン）。
 *
 * `synthAll()` は認証情報もネットワークも使わない。AWS アカウントの実在確認
 * （lookup）やコンテキストプロバイダを一切呼ばないため、CI でも手元でも
 * 同じ JSON が得られる（決定的）。
 *
 * スタック構成（依存方向は矢印の向きのみ。循環参照は無い）:
 *
 * ```text
 * dencho-storage  <-- dencho-compute  <-- dencho-guardrails
 *                                   \-- dencho-workflow
 * ```
 */
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as cdk from 'aws-cdk-lib';
import type { CfnResource, CfnTemplate, InfraSnapshot } from '../core/types.js';
import { resolveEnvironment, resolveHandlersDir } from './context.js';
import { ComputeStack } from './stacks/compute-stack.js';
import { GuardrailsStack } from './stacks/guardrails-stack.js';
import { StorageStack } from './stacks/storage-stack.js';
import { WorkflowStack } from './stacks/workflow-stack.js';

/** 合成対象のスタック名。 */
export type StackName = 'dencho-storage' | 'dencho-compute' | 'dencho-guardrails' | 'dencho-workflow';

/** 合成対象のスタック名（この順序で `InfraSnapshot.stacks` に格納する）。 */
export const STACK_NAMES: readonly StackName[] = [
  'dencho-storage',
  'dencho-compute',
  'dencho-guardrails',
  'dencho-workflow',
];

/** CDK アプリ合成のオプション。 */
export interface SynthOptions {
  /**
   * Lambda ハンドラ（ビルド済み JavaScript）のディレクトリ。
   * 省略時はパッケージルートの `dist/handlers`。
   */
  readonly handlersDir?: string;
  /**
   * 合成に使う AWS アカウント / リージョン。
   * 省略時はダミーアカウント `111122223333` と `ap-northeast-1`（東京）。
   */
  readonly env?: { readonly account: string; readonly region: string };
}

/**
 * 4 スタックを組み立てた CDK アプリを返す（合成はまだ行わない）。
 *
 * `npx cdk synth` から使うほか、テストでスタック単位の検証に使う。
 * 認証情報・ネットワークには一切アクセスしない。
 *
 * @param options ハンドラディレクトリと AWS 環境の上書き。
 * @returns スタックを登録済みの CDK アプリ。
 * @throws Lambda ハンドラディレクトリが存在しない場合（先に `npm run build` が必要）。
 */
export function buildApp(options: SynthOptions = {}): cdk.App {
  return createApp(options);
}

/**
 * 4 スタックを合成し、スタック名 -> CloudFormation テンプレートのスナップショットを返す。
 *
 * 合成は一時ディレクトリに対して行い、終了時に削除する。同じ入力に対して
 * 常に同じ JSON を返す（決定的）。適合性検証エンジン（compliance）はこの
 * スナップショットを受け取ってインフラ要件（INF-01..INF-10）を検査する。
 *
 * @param options ハンドラディレクトリと AWS 環境の上書き。
 * @returns スタック名をキーにしたテンプレート集。
 * @throws Lambda ハンドラディレクトリが存在しない場合。
 */
export function synthAll(options: SynthOptions = {}): InfraSnapshot {
  const outdir = mkdtempSync(join(tmpdir(), 'dencho-cdk-synth-'));
  try {
    const app = createApp(options, outdir);
    const assembly = app.synth();
    const stacks: Record<string, CfnTemplate> = {};
    for (const stackName of STACK_NAMES) {
      const artifact = assembly.getStackByName(stackName);
      stacks[stackName] = toCfnTemplate(artifact.template, stackName);
    }
    return { stacks };
  } finally {
    rmSync(outdir, { recursive: true, force: true });
  }
}

/**
 * アプリを生成して 4 スタックを登録する。
 *
 * @param options 合成オプション。
 * @param outdir 明示的な出力先（`synthAll` が一時ディレクトリを渡す）。
 */
function createApp(options: SynthOptions, outdir?: string): cdk.App {
  const env = resolveEnvironment(options.env);
  const handlersDir = resolveHandlersDir(options.handlersDir);
  assertHandlersDirectory(handlersDir);

  const app = outdir === undefined ? new cdk.App() : new cdk.App({ outdir });

  const storage = new StorageStack(app, 'dencho-storage', { env });
  const compute = new ComputeStack(app, 'dencho-compute', { env, storage, handlersDir });
  new GuardrailsStack(app, 'dencho-guardrails', { env, storage, compute });
  new WorkflowStack(app, 'dencho-workflow', { env, compute });

  return app;
}

/**
 * ハンドラディレクトリの存在を確認する。
 *
 * ここで明示的に失敗させることで、`Code.fromAsset` の分かりにくい
 * 「アセットが見つからない」エラーの代わりに、対処方法を示すメッセージを出す。
 */
function assertHandlersDirectory(handlersDir: string): void {
  if (!existsSync(handlersDir) || !statSync(handlersDir).isDirectory()) {
    throw new Error(
      `Lambda ハンドラのディレクトリが見つかりません: ${handlersDir}\n` +
        '  `npm run build` で dist/handlers を生成するか、SynthOptions.handlersDir（環境変数 DENCHO_HANDLERS_DIR）を指定してください。',
    );
  }
}

/**
 * 合成されたテンプレートを `CfnTemplate` に正規化する。
 *
 * CDK の Cloud Assembly が返すテンプレートには `Metadata` など多数の
 * 付随情報があるが、適合性検証が必要とする `Resources`（と形式バージョン）
 * だけを取り出す。
 */
function toCfnTemplate(raw: unknown, stackName: string): CfnTemplate {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error(`スタック ${stackName} のテンプレートが不正です（オブジェクトではありません）。`);
  }
  const record = raw as Readonly<Record<string, unknown>>;
  const resources = record['Resources'];
  if (!isResourceRecord(resources)) {
    throw new Error(`スタック ${stackName} のテンプレートに Resources がありません。`);
  }
  const version = record['AWSTemplateFormatVersion'];
  if (typeof version === 'string') {
    return { AWSTemplateFormatVersion: version, Resources: resources };
  }
  return { Resources: resources };
}

/** 値が CloudFormation の `Resources` マップとして妥当かを判定する。 */
function isResourceRecord(value: unknown): value is Readonly<Record<string, CfnResource>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const entries = Object.values(value as Readonly<Record<string, unknown>>);
  return entries.every(
    (entry) => typeof entry === 'object' && entry !== null && typeof (entry as { readonly Type?: unknown }).Type === 'string',
  );
}
