/**
 * CDK スタックのテスト用ユーティリティ。
 *
 * 実ビルド成果物 `dist/handlers` には依存しない。必ず一時ディレクトリを
 * `handlersDir` として渡し、テストごとに 1 回だけ合成して共有する。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Template } from 'aws-cdk-lib/assertions';
import type { CfnTemplate, InfraSnapshot } from '../../src/core/types.js';
import { synthAll, type StackName } from '../../src/cdk/synth.js';

/** 合成済みのテスト用インフラ。 */
export interface TestInfra {
  /** 全スタックの合成結果。 */
  readonly snapshot: InfraSnapshot;
  /** 合成に使った一時ハンドラディレクトリ（追加の合成に再利用できる）。 */
  readonly handlersDir: string;
  /** 一時ディレクトリを削除する。 */
  readonly cleanup: () => void;
}

/**
 * 一時 `handlersDir` を作成して 4 スタックを合成する。
 *
 * 合成に失敗した場合も一時ディレクトリを確実に削除する。
 */
export function createTestInfra(): TestInfra {
  const handlersDir = mkdtempSync(join(tmpdir(), 'dencho-cdk-handlers-'));
  const cleanup = (): void => {
    rmSync(handlersDir, { recursive: true, force: true });
  };
  try {
    for (const kind of ['ingest', 'search', 'export', 'verify'] as const) {
      writeFileSync(join(handlersDir, `${kind}.js`), 'export const handler = async () => ({ ok: true });\n');
    }
    return { snapshot: synthAll({ handlersDir }), handlersDir, cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}

/** 指定スタックの `Template`（assertions API 用）を返す。 */
export function templateFor(infra: TestInfra, stackName: StackName): Template {
  const template = cfnTemplateOf(infra, stackName);
  return Template.fromString(JSON.stringify(template));
}

/** 指定スタックの `CfnTemplate`（素の JSON 走査用）を返す。 */
export function cfnTemplateOf(infra: TestInfra, stackName: StackName): CfnTemplate {
  const template = infra.snapshot.stacks[stackName];
  if (template === undefined) {
    throw new Error(`スタック ${stackName} がスナップショットにありません`);
  }
  return template;
}

/** JSON オブジェクト（キーは任意）。 */
export type JsonObject = Readonly<Record<string, unknown>>;

/** 値が null でないオブジェクトならそのまま返す。 */
export function asObject(value: unknown): JsonObject | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as JsonObject;
}

/** 値が配列ならそのまま返し、それ以外は空配列を返す。 */
export function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? (value as readonly unknown[]) : [];
}

/** `root` からキー列をたどって値を取得する（途中で欠けたら `undefined`）。 */
export function at(root: unknown, ...path: readonly string[]): unknown {
  let current: unknown = root;
  for (const key of path) {
    if (Array.isArray(current)) {
      const index = Number(key);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) {
        return undefined;
      }
      current = current[index];
      continue;
    }
    const object = asObject(current);
    if (object === undefined) {
      return undefined;
    }
    current = object[key];
  }
  return current;
}

/** `at` でたどった値が文字列なら返す。 */
export function stringAt(root: unknown, ...path: readonly string[]): string | undefined {
  const value = at(root, ...path);
  return typeof value === 'string' ? value : undefined;
}

/** `at` でたどった値が数値なら返す。 */
export function numberAt(root: unknown, ...path: readonly string[]): number | undefined {
  const value = at(root, ...path);
  return typeof value === 'number' ? value : undefined;
}

/** `at` でたどった値が真偽値なら返す。 */
export function booleanAt(root: unknown, ...path: readonly string[]): boolean | undefined {
  const value = at(root, ...path);
  return typeof value === 'boolean' ? value : undefined;
}

/** テンプレート内の 1 リソース。 */
export interface TemplateResource {
  readonly Type: string;
  readonly Properties?: JsonObject;
  readonly DeletionPolicy?: string;
  readonly UpdateReplacePolicy?: string;
  readonly DependsOn?: unknown;
}

/** `Resources` マップを持つテンプレート JSON。 */
export interface TemplateDocument {
  readonly AWSTemplateFormatVersion?: string;
  readonly Resources: Readonly<Record<string, TemplateResource>>;
}

/** `CfnTemplate` の型を保ったまま、テストで走査しやすい素の JSON に変換する。 */
export function documentOf(template: CfnTemplate): TemplateDocument {
  return JSON.parse(JSON.stringify(template)) as TemplateDocument;
}

/** 指定タイプのリソース一覧（論理 ID 付き）。 */
export function resourcesOfType(
  document: TemplateDocument,
  type: string,
): readonly { readonly logicalId: string; readonly resource: TemplateResource }[] {
  return Object.entries(document.Resources)
    .filter(([, resource]) => resource.Type === type)
    .map(([logicalId, resource]) => ({ logicalId, resource }));
}

/** 指定タイプのリソースがただ 1 つであることを前提に取り出す。 */
export function singleResourceOfType(document: TemplateDocument, type: string): TemplateResource {
  const matches = resourcesOfType(document, type);
  if (matches.length !== 1 || matches[0] === undefined) {
    throw new Error(`${type} は 1 つだけ存在する想定ですが ${matches.length} 個見つかりました`);
  }
  return matches[0].resource;
}

/** IAM ステートメントの正規化表現。 */
export interface IamStatement {
  /** 由来（IAM::Policy / Role の論理 ID）。 */
  readonly source: string;
  /** 許可/拒否されたアクション名（文字列化）。 */
  readonly actions: readonly string[];
  /** リソース（トークンを含む場合はオブジェクトのまま）。 */
  readonly resources: readonly unknown[];
}

/** アクション / リソースの値を文字列配列に正規化する。 */
function toStringArray(value: unknown): readonly string[] {
  if (typeof value === 'string') {
    return [value];
  }
  return asArray(value).filter((entry): entry is string => typeof entry === 'string');
}

/** リソースの値を配列に正規化する（単一の文字列 / トークンも 1 要素として扱う）。 */
function toResourceArray(value: unknown): readonly unknown[] {
  if (value === undefined) {
    return [];
  }
  return Array.isArray(value) ? (value as readonly unknown[]) : [value];
}

/** ポリシードキュメント（`{Statement: [...]}`）からステートメントを抽出する。 */
function statementsOfDocument(document: unknown, source: string): readonly IamStatement[] {
  return asArray(at(document, 'Statement')).flatMap((statement) => {
    const object = asObject(statement);
    if (object === undefined) {
      return [];
    }
    return [
      {
        source,
        actions: toStringArray(object['Action']),
        resources: toResourceArray(object['Resource']),
      },
    ];
  });
}

/** テンプレート内のすべての IAM ポリシー（インライン / 信頼ポリシー）のステートメント。 */
export function iamStatements(document: TemplateDocument): readonly IamStatement[] {
  return Object.entries(document.Resources).flatMap(([logicalId, resource]) => {
    if (resource.Type === 'AWS::IAM::Policy' || resource.Type === 'AWS::IAM::ManagedPolicy') {
      return statementsOfDocument(at(resource.Properties, 'PolicyDocument'), logicalId);
    }
    if (resource.Type === 'AWS::IAM::Role') {
      return statementsOfDocument(at(resource.Properties, 'AssumeRolePolicyDocument'), logicalId);
    }
    return [];
  });
}

/** 指定した論理 ID の IAM ロールにアタッチされたインラインポリシーのステートメント。 */
export function statementsForRole(document: TemplateDocument, roleLogicalId: string): readonly IamStatement[] {
  return Object.entries(document.Resources).flatMap(([logicalId, resource]) => {
    if (resource.Type !== 'AWS::IAM::Policy') {
      return [];
    }
    const attachedRoleIds = asArray(at(resource.Properties, 'Roles')).flatMap((entry) => {
      const ref = stringAt(entry, 'Ref');
      return ref === undefined ? [] : [ref];
    });
    if (!attachedRoleIds.includes(roleLogicalId)) {
      return [];
    }
    return statementsOfDocument(at(resource.Properties, 'PolicyDocument'), logicalId);
  });
}

/** Lambda 関数名から、その実行ロールの論理 ID を返す。 */
export function roleLogicalIdOfFunction(document: TemplateDocument, functionName: string): string | undefined {
  for (const { resource } of resourcesOfType(document, 'AWS::Lambda::Function')) {
    if (stringAt(resource.Properties, 'FunctionName') !== functionName) {
      continue;
    }
    return stringAt(resource.Properties, 'Role', 'Fn::GetAtt', '0');
  }
  return undefined;
}

/** 指定ロールが持つアクション名の一覧。 */
export function actionsForRole(document: TemplateDocument, roleLogicalId: string): readonly string[] {
  return statementsForRole(document, roleLogicalId).flatMap((statement) => statement.actions);
}
