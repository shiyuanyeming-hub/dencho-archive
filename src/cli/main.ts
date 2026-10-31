#!/usr/bin/env node
/**
 * `dencho` コマンドのエントリポイント。
 *
 * 例外はここで捕捉し、利用者向けのメッセージと終了コードへ変換する。
 * 予期しない例外でも終了コード 2 を返し、CI が「不適合」と「実行失敗」を
 * 取り違えないようにする。
 */
import path from 'node:path';
import { CliError, parseArgs, USAGE, type ParsedArgs } from './args.js';
import {
  EXIT_ERROR,
  EXIT_OK,
  commandAudit,
  commandCapability,
  commandExport,
  commandIngest,
  commandInit,
  commandReindex,
  commandSearch,
  commandSynth,
  commandVerify,
  type CommandIo,
} from './commands.js';
import { runDemo } from './demo.js';
import { TOOL_NAME, TOOL_VERSION } from '../version.js';

/** 出力ストリームの抽象。テストはバッファへ書き込む実装を渡す。 */
export interface CliStreams {
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
  readonly cwd?: string;
}

/** CLI 本体。`main.ts` はこれを呼ぶだけにする。 */
export async function run(argv: readonly string[], streams: CliStreams): Promise<number> {
  const io: CommandIo = {
    out: streams.stdout,
    err: streams.stderr,
    cwd: streams.cwd ?? process.cwd(),
  };

  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
  } catch (error) {
    if (error instanceof CliError) {
      streams.stderr(`エラー: ${error.message}`);
      return EXIT_ERROR;
    }
    throw error;
  }

  try {
    switch (args.command) {
      case 'help':
        streams.stdout(USAGE);
        return EXIT_OK;
      case 'version':
        streams.stdout(`${TOOL_NAME} ${TOOL_VERSION} (node ${process.version})`);
        return EXIT_OK;
      case 'init':
        return await commandInit(args, io);
      case 'ingest':
        return await commandIngest(args, io);
      case 'search':
        return await commandSearch(args, io);
      case 'export':
        return await commandExport(args, io);
      case 'verify':
        return await commandVerify(args, io);
      case 'audit':
        return await commandAudit(args, io);
      case 'reindex':
        return await commandReindex(args, io);
      case 'capability':
        return await commandCapability(args, io);
      case 'synth':
        return await commandSynth(args, io);
      case 'demo':
        return await runDemo({
          dir: path.resolve(io.cwd, args.values['dir'] ?? '.dencho-demo'),
          keep: args.booleans.has('keep'),
          write: (line) => streams.stdout(line),
        });
      default:
        streams.stderr(`未知のコマンドです。\n\n${USAGE}`);
        return EXIT_ERROR;
    }
  } catch (error) {
    if (error instanceof CliError) {
      streams.stderr(`エラー: ${error.message}`);
      return EXIT_ERROR;
    }
    if (isUserFacingError(error)) {
      streams.stderr(`エラー: ${error.message}`);
      return EXIT_ERROR;
    }
    streams.stderr(`予期しないエラー: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    return EXIT_ERROR;
  }
}

/** 利用者にそのまま見せてよいエラーか（ドメインエラー・入力エラー）。 */
function isUserFacingError(error: unknown): error is Error {
  if (!(error instanceof Error)) {
    return false;
  }
  return (
    error.name === 'ValidationError' ||
    error.name === 'NotFoundError' ||
    error.name === 'ConflictError' ||
    error.name === 'IntegrityError' ||
    error.name === 'ArchiveError'
  );
}

async function main(): Promise<void> {
  const code = await run(process.argv.slice(2), {
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
  });
  process.exitCode = code;
}

main().catch((error: unknown) => {
  process.stderr.write(`予期しないエラー: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exitCode = 2;
});
