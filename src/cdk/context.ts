/**
 * CDK アプリの実行文脈（環境既定値・パス解決・環境変数オーバーライド）を扱う。
 *
 * 設計方針:
 * - CDK の合成（synth）は、認証情報もネットワークも使わずに完結させる。
 *   `Vpc.fromLookup` / `Bucket.fromBucketName` / `Aws.accountId` のような
 *   「アカウント実在確認（lookup）」は一切使わない。既定値はコード上の
 *   ダミーアカウントで固定し、実際のデプロイ時だけ上書きする。
 * - Lambda ハンドラの成果物ディレクトリは、パッケージルートを
 *   `package.json` の探索で特定して解決する。これにより `src/cdk` から
 *   実行しても `dist/cdk` から実行しても同じ場所を指す。
 */
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** AWS アカウント ID とリージョンの組。 */
export interface AwsEnvironment {
  readonly account: string;
  readonly region: string;
}

/**
 * 合成時に使う既定アカウント ID。
 *
 * 認証情報なしで `cdk synth` を通すためのダミー値であり、このアカウントには
 * 何もデプロイされない。実デプロイ時は `DENCHO_ACCOUNT` で上書きする。
 */
export const DEFAULT_ACCOUNT = '111122223333';

/** 既定リージョン（東京）。日本国内の証憑を扱うため ap-northeast-1 を既定にする。 */
export const DEFAULT_REGION = 'ap-northeast-1';

/** アカウント ID を上書きする環境変数名。 */
export const ACCOUNT_ENV_NAME = 'DENCHO_ACCOUNT';

/** リージョンを上書きする環境変数名。 */
export const REGION_ENV_NAME = 'DENCHO_REGION';

/** Lambda ハンドラ成果物ディレクトリを上書きする環境変数名。 */
export const HANDLERS_DIR_ENV_NAME = 'DENCHO_HANDLERS_DIR';

/** パッケージルートから見た Lambda ハンドラ成果物の相対パス。 */
export const HANDLERS_DIR_RELATIVE_PATH = join('dist', 'handlers');

/**
 * 環境既定値に任意の上書きを重ねた AWS 環境設定を返す。
 *
 * @param overrides アカウント / リージョンの部分的な上書き。空文字は未指定として扱う。
 * @returns アカウントとリージョンが必ず埋まった設定。
 */
export function resolveEnvironment(overrides?: Partial<AwsEnvironment>): AwsEnvironment {
  return {
    account: nonEmpty(overrides?.account) ?? DEFAULT_ACCOUNT,
    region: nonEmpty(overrides?.region) ?? DEFAULT_REGION,
  };
}

/**
 * `package.json` を含む最も近い祖先ディレクトリをパッケージルートとして返す。
 *
 * `dist/cdk/synth.js` から実行しても `src/cdk/synth.ts`（テスト実行時）から
 * 実行しても、同じパッケージルートに到達する。`node_modules` 配下に
 * インストールされた場合も、最も近い `package.json` で止まるため安全である。
 *
 * @param startDirectory 探索開始ディレクトリ（既定: このモジュールのディレクトリ）。
 * @returns パッケージルートの絶対パス。
 * @throws ルートまで到達しても `package.json` が無い場合。
 */
export function findPackageRoot(startDirectory: string = moduleDirectory()): string {
  let current = resolve(startDirectory);
  for (;;) {
    if (existsSync(join(current, 'package.json'))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      throw new Error(
        `package.json が見つかりません（探索開始: ${startDirectory}）。リポジトリ外で実行していませんか？`,
      );
    }
    current = parent;
  }
}

/**
 * Lambda ハンドラ（ビルド済み JavaScript）のディレクトリを解決する。
 *
 * 明示指定が無い場合は `<パッケージルート>/dist/handlers` を返す。
 * テストは一時ディレクトリを明示的に渡すことでビルド成果物に依存しない。
 *
 * @param explicitPath 明示的なディレクトリ（相対パスは現在の作業ディレクトリ基準）。
 * @returns ハンドラディレクトリの絶対パス。
 */
export function resolveHandlersDir(explicitPath?: string): string {
  const candidate = nonEmpty(explicitPath);
  if (candidate !== undefined) {
    return resolve(candidate);
  }
  return join(findPackageRoot(), HANDLERS_DIR_RELATIVE_PATH);
}

/**
 * 環境変数（および既定値）から合成設定を組み立てる。
 *
 * `cdk.json` から起動する `app.ts` と `synth-cli.ts` の両方が使う。
 *
 * @param environment 環境変数の読み取り元（通常は `process.env`）。
 * @returns AWS 環境とハンドラディレクトリ。
 */
export function readSettings(environment: NodeJS.ProcessEnv): CdkSettings {
  return {
    env: resolveEnvironment({
      account: environment[ACCOUNT_ENV_NAME],
      region: environment[REGION_ENV_NAME],
    }),
    handlersDir: resolveHandlersDir(environment[HANDLERS_DIR_ENV_NAME]),
  };
}

/** `readSettings` が返す合成設定。 */
export interface CdkSettings {
  /** 合成に使う AWS アカウント / リージョン。 */
  readonly env: AwsEnvironment;
  /** Lambda ハンドラ成果物の絶対パス。 */
  readonly handlersDir: string;
}

/**
 * このモジュール自身のディレクトリを返す。
 *
 * Node 20.11+ の `import.meta.dirname` を使い、バンドラ等で未定義の場合は
 * `import.meta.url` から復元する。
 */
function moduleDirectory(): string {
  const fromMeta: string | undefined = import.meta.dirname;
  if (fromMeta !== undefined && fromMeta.length > 0) {
    return fromMeta;
  }
  return dirname(fileURLToPath(import.meta.url));
}

/** 前後空白を除去し、空文字なら `undefined` にする。 */
function nonEmpty(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}
