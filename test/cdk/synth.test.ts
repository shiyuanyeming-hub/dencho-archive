/**
 * 合成エントリポイント（`src/cdk/synth.ts` / 実行文脈）のテスト。
 *
 * 「認証情報なし・ネットワークなしで、決定的に合成できる」ことを
 * このプロジェクトのインフラ品質の前提として固定する。
 */
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as cdk from 'aws-cdk-lib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_ACCOUNT, DEFAULT_REGION, findPackageRoot, resolveEnvironment, resolveHandlersDir } from '../../src/cdk/context.js';
import { STACK_NAMES, buildApp, synthAll } from '../../src/cdk/synth.js';
import { createTestInfra, documentOf, iamStatements, type TestInfra } from './helpers.js';

/**
 * AWS の認証情報に関わる環境変数を一時的に取り除いて処理を実行する。
 *
 * 「認証情報が無くても合成できる」ことを、環境に依存せず検証するため。
 */
function withoutAwsCredentials<T>(run: () => T): T {
  const keys = [
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_SESSION_TOKEN',
    'AWS_PROFILE',
    'AWS_REGION',
    'AWS_DEFAULT_REGION',
    'AWS_SDK_LOAD_CONFIG',
  ] as const;
  const saved = new Map<string, string | undefined>(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) {
    delete process.env[key];
  }
  try {
    return run();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

describe('synthAll / buildApp', () => {
  let infra: TestInfra;

  beforeAll(() => {
    infra = createTestInfra();
  });

  afterAll(() => {
    infra.cleanup();
  });

  it('4 つのスタックを固定順で返す', () => {
    expect(Object.keys(infra.snapshot.stacks)).toEqual([...STACK_NAMES]);
    for (const name of STACK_NAMES) {
      const template = infra.snapshot.stacks[name];
      expect(template, `${name} が存在すること`).toBeDefined();
      expect(Object.keys(template?.Resources ?? {}).length, `${name} のリソース数`).toBeGreaterThan(0);
    }
    const totalResources = Object.values(infra.snapshot.stacks).reduce(
      (total, template) => total + Object.keys(template.Resources).length,
      0,
    );
    // storage 7 + compute 28 + guardrails 5 + workflow 5 = 45。
    expect(totalResources).toBe(45);
  });

  it('同じ入力なら同じ JSON を返す（決定的）', () => {
    const first = synthAll({ handlersDir: infra.handlersDir });
    const second = synthAll({ handlersDir: infra.handlersDir });
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(second).toEqual(first);
  });

  it('スナップショットは必要なキーだけを残す（合成メタデータを含めない）', () => {
    for (const template of Object.values(infra.snapshot.stacks)) {
      for (const key of Object.keys(template)) {
        expect(['Resources', 'AWSTemplateFormatVersion']).toContain(key);
      }
    }
  });

  it('全リソースが AWS:: タイプで、カスタムリソースを含まない', () => {
    for (const [stackName, template] of Object.entries(infra.snapshot.stacks)) {
      for (const [logicalId, resource] of Object.entries(template.Resources)) {
        expect(resource.Type, `${stackName}/${logicalId}`).toMatch(/^AWS::/);
      }
    }
  });

  it('全スタックの IAM ポリシーにワイルドカードが無い', () => {
    const violations: string[] = [];
    for (const [stackName, template] of Object.entries(infra.snapshot.stacks)) {
      for (const statement of iamStatements(documentOf(template))) {
        if (statement.actions.includes('*') || statement.resources.includes('*')) {
          violations.push(`${stackName}: ${statement.source}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('既定の環境はダミーアカウントと東京リージョン', () => {
    expect(resolveEnvironment()).toEqual({ account: DEFAULT_ACCOUNT, region: DEFAULT_REGION });
    expect(DEFAULT_ACCOUNT).toBe('111122223333');
    expect(DEFAULT_REGION).toBe('ap-northeast-1');
  });

  it('env を指定すると全スタックがそのアカウント / リージョンになる', () => {
    const app = buildApp({
      handlersDir: infra.handlersDir,
      env: { account: '999988887777', region: 'us-east-1' },
    });
    const storage = app.node.findChild('dencho-storage');
    expect(storage instanceof cdk.Stack).toBe(true);
    if (!(storage instanceof cdk.Stack)) {
      throw new Error('dencho-storage スタックが見つかりません');
    }
    expect(storage.account).toBe('999988887777');
    expect(storage.region).toBe('us-east-1');

    const snapshot = synthAll({ handlersDir: infra.handlersDir, env: { account: '999988887777', region: 'us-east-1' } });
    expect(JSON.stringify(snapshot)).toContain('999988887777');
  });

  it('handlersDir の既定値はパッケージルート配下の dist/handlers', () => {
    const packageRoot = findPackageRoot();
    expect(resolveHandlersDir()).toBe(join(packageRoot, 'dist', 'handlers'));
    expect(resolveHandlersDir()).toMatch(/\/dist\/handlers$/);
    // パッケージルートには package.json と cdk.json が実在する。
    expect(() => readFileSync(join(packageRoot, 'package.json'), 'utf8')).not.toThrow();
    expect(() => readFileSync(join(packageRoot, 'cdk.json'), 'utf8')).not.toThrow();
  });

  it('handlersDir が存在しない場合は対処方法を示すエラーになる', () => {
    const missing = join(tmpdir(), `dencho-cdk-missing-handlers-${Date.now()}`);
    expect(() => buildApp({ handlersDir: missing })).toThrow(/ハンドラのディレクトリが見つかりません/);
  });

  it('AWS の認証情報環境変数が無くても合成できる', () => {
    const snapshot = withoutAwsCredentials(() => synthAll({ handlersDir: infra.handlersDir }));
    expect(Object.keys(snapshot.stacks)).toEqual([...STACK_NAMES]);
  });

  it('cdk.json の app は dist/cdk/app.js を指し、出力先は cdk.out', () => {
    const raw = readFileSync(join(findPackageRoot(), 'cdk.json'), 'utf8');
    const config = JSON.parse(raw) as { readonly app?: unknown; readonly output?: unknown };
    expect(config.app).toBe('node dist/cdk/app.js');
    expect(config.output).toBe('cdk.out');
  });

  it('スタック間の依存に循環が無い（合成が成功すること自体で検証）', () => {
    // synthAll は全スタックを一括合成する。循環参照があれば CDK が例外を投げる。
    expect(() => synthAll({ handlersDir: infra.handlersDir })).not.toThrow();
    // Guardrails は storage / compute に依存し、Workflow は compute に依存する。
    const guardrails = infra.snapshot.stacks['dencho-guardrails'];
    const workflow = infra.snapshot.stacks['dencho-workflow'];
    expect(JSON.stringify(guardrails)).toContain('dencho-storage:ExportsOutput');
    expect(JSON.stringify(guardrails)).toContain('dencho-compute:ExportsOutput');
    expect(JSON.stringify(workflow)).toContain('dencho-compute:ExportsOutput');
  });
});
