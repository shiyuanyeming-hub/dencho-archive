/**
 * CLI の引数解析。
 *
 * 依存を増やさないため自前で実装する。`--key value` と `--key=value` の
 * 両方を受け付け、未知のフラグはエラーにする（打ち間違いを黙って無視しない）。
 */

/** サブコマンド。 */
export type CommandName =
  | 'init'
  | 'ingest'
  | 'search'
  | 'export'
  | 'verify'
  | 'audit'
  | 'reindex'
  | 'capability'
  | 'synth'
  | 'demo'
  | 'help'
  | 'version';

/** 値を取るフラグ。 */
const VALUE_FLAGS = new Set([
  'dir',
  'archive-id',
  'archive-id',
  'voucher-id',
  'date',
  'amount',
  'counterparty',
  'type',
  'received-at',
  'registration',
  'bulk',
  'from',
  'to',
  'amount-min',
  'amount-max',
  'limit',
  'format',
  'out',
  'infra',
]);

/** 真偽値フラグ。 */
const BOOLEAN_FLAGS = new Set(['json', 'keep', 'help', 'version', 'no-infra', 'quiet']);

/** 全サブコマンド。 */
const COMMANDS: readonly CommandName[] = [
  'init',
  'ingest',
  'search',
  'export',
  'verify',
  'audit',
  'reindex',
  'capability',
  'synth',
  'demo',
  'help',
  'version',
];

/** 解析結果。 */
export interface ParsedArgs {
  readonly command: CommandName;
  readonly positionals: readonly string[];
  readonly values: Readonly<Record<string, string>>;
  readonly booleans: ReadonlySet<string>;
}

/** 引数エラー。CLI はこれを捕捉して使い方を表示し終了コード 2 を返す。 */
export class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliError';
  }
}

/** 使い方の全文。 */
export const USAGE = `dencho — 電帳法対応の証憑アーカイブ CLI

使い方:
  dencho <コマンド> [オプション]

コマンド:
  init        アーカイブを初期化する
  ingest      証憑を取り込む（単体 / バルク）
  search      取引年月日・金額・取引先で検索する
  export      検索結果を CSV / JSON で出力する（税務調査のダウンロード対応）
  verify      ハッシュチェーンの整合性を検証する
  audit       電帳法の適合性を監査する
  reindex     台帳から検索索引を再構築する
  capability  検索要件の充足状況を表示する
  synth       AWS CDK の CloudFormation テンプレートを出力する
  demo        お試し用の一連の流れを実行する

共通オプション:
  --dir <パス>           アーカイブのディレクトリ（既定: .dencho）
  --json                 機械可読 JSON で出力する
  -h, --help             この使い方を表示する
  -v, --version          バージョンを表示する

ingest:
  --bulk <manifest>      バルク取り込み用 JSON を指定する
  --voucher-id <id>      証憑 ID（単体取り込みで必須）
  --date <YYYY-MM-DD>    取引年月日
  --amount <円>          取引金額（整数）
  --counterparty <名称>  取引先名
  --type <種別>          invoice / receipt / delivery-note / contract / order / statement / other
  --received-at <ISO>    受領時刻（既定: 現在時刻）
  --registration <T...>  インボイス登録番号

search / export の条件:
  --from <YYYY-MM-DD>    取引年月日の下限
  --to <YYYY-MM-DD>      取引年月日の上限
  --amount-min <円>      金額の下限
  --amount-max <円>      金額の上限
  --counterparty <名称>  取引先（部分一致・表記ゆれ吸収）
  --type <種別>          書類種別
  --limit <件数>         最大件数
  --format <形式>        search: pretty|json / export: csv|json
  --out <パス>           出力ファイル（export）

audit:
  --infra <auto|none|パス> 合成済みインフラ定義を使うか（既定: auto）
  --format <markdown|json>

demo:
  --keep                 デモ用ディレクトリを残す

終了コード:
  0  成功（audit は適合）
  1  検証失敗（チェーン破損 / 不適合）
  2  引数・実行エラー
`;

/** 引数を解析する。 */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  if (argv.length === 0) {
    return { command: 'help', positionals: [], values: {}, booleans: new Set() };
  }

  const [head, ...rest] = argv;
  const first = head ?? '';
  let command: CommandName | undefined;

  if (first === '-h' || first === '--help') {
    return { command: 'help', positionals: [], values: {}, booleans: new Set(['help']) };
  }
  if (first === '-v' || first === '--version') {
    return { command: 'version', positionals: [], values: {}, booleans: new Set(['version']) };
  }
  if (COMMANDS.includes(first as CommandName)) {
    command = first as CommandName;
  }

  const tokens = command === undefined ? argv : rest;
  const positionals: string[] = [];
  const values: Record<string, string> = {};
  const booleans = new Set<string>();

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined) {
      continue;
    }

    if (token === '-h' || token === '--help') {
      return { command: 'help', positionals, values, booleans: new Set(['help']) };
    }
    if (token === '-v' || token === '--version') {
      return { command: 'version', positionals, values, booleans: new Set(['version']) };
    }

    if (!token.startsWith('--')) {
      if (token.startsWith('-')) {
        throw new CliError(`未知のオプションです: ${token}`);
      }
      positionals.push(token);
      continue;
    }

    const body = token.slice(2);
    const equalsIndex = body.indexOf('=');
    const key = equalsIndex === -1 ? body : body.slice(0, equalsIndex);
    const inlineValue = equalsIndex === -1 ? undefined : body.slice(equalsIndex + 1);

    if (BOOLEAN_FLAGS.has(key)) {
      if (inlineValue !== undefined) {
        booleans.add(inlineValue === 'true' ? key : `${key}:false`);
      } else {
        booleans.add(key);
      }
      continue;
    }

    if (!VALUE_FLAGS.has(key)) {
      throw new CliError(`未知のオプションです: --${key}`);
    }

    if (inlineValue !== undefined) {
      values[key] = inlineValue;
      continue;
    }

    const next = tokens[index + 1];
    if (next === undefined || next.startsWith('--')) {
      throw new CliError(`--${key} には値が必要です`);
    }
    values[key] = next;
    index += 1;
  }

  // サブコマンドが省略された場合、位置引数をコマンドとして解釈する。
  const resolvedCommand: CommandName = command ?? 'help';
  if (command === undefined && positionals.length > 0) {
    const candidate = positionals[0] ?? '';
    if (COMMANDS.includes(candidate as CommandName)) {
      return {
        command: candidate as CommandName,
        positionals: positionals.slice(1),
        values,
        booleans,
      };
    }
    throw new CliError(`未知のコマンドです: ${candidate}\n\n${USAGE}`);
  }

  return { command: resolvedCommand, positionals, values, booleans };
}

/** 文字列フラグを取り出す。 */
export function flagValue(args: ParsedArgs, key: string): string | undefined {
  return args.values[key];
}

/** 必須の文字列フラグを取り出す。 */
export function requireFlag(args: ParsedArgs, key: string, hint: string): string {
  const value = args.values[key];
  if (value === undefined || value.trim() === '') {
    throw new CliError(`--${key} は必須です（${hint}）`);
  }
  return value;
}

/** 整数フラグを取り出す。 */
export function optionalInteger(args: ParsedArgs, key: string): number | undefined {
  const value = args.values[key];
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || String(parsed) !== value.trim()) {
    throw new CliError(`--${key} には整数を指定してください: ${value}`);
  }
  return parsed;
}

/** 真偽値フラグを判定する。 */
export function flag(args: ParsedArgs, key: string): boolean {
  return args.booleans.has(key) && !args.booleans.has(`${key}:false`);
}
