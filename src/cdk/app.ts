/**
 * `cdk synth` のエントリポイント（`cdk.json` の `app` に指定する）。
 *
 * ```bash
 * npm run build
 * npx cdk synth      # または: node dist/cdk/app.js
 * ```
 *
 * CDK CLI からは `CDK_OUTDIR` が渡される。`node dist/cdk/app.js` を直接実行
 * した場合でも成果物が `cdk.out/` に残るよう、未設定時のみ既定値を補う。
 * 認証情報・ネットワークアクセスは不要（オフライン合成）。
 */
import { buildApp } from './synth.js';
import { readSettings } from './context.js';

const settings = readSettings(process.env);

if (process.env['CDK_OUTDIR'] === undefined) {
  process.env['CDK_OUTDIR'] = 'cdk.out';
}

const app = buildApp({ env: settings.env, handlersDir: settings.handlersDir });
app.synth();
