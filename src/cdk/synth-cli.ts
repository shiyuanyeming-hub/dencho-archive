/**
 * 全スタックを合成し、`InfraSnapshot` を JSON で標準出力へ書き出す CLI。
 *
 * ```bash
 * npm run build
 * npm run synth   # = node dist/cdk/synth-cli.js
 * ```
 *
 * 出力は決定的な JSON のため、CI で適合性検証エンジンの入力として使える。
 * 認証情報・ネットワークアクセスは不要（オフライン合成）。
 */
import { readSettings } from './context.js';
import { synthAll } from './synth.js';

const settings = readSettings(process.env);
const snapshot = synthAll({ env: settings.env, handlersDir: settings.handlersDir });
process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
