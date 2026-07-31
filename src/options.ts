import { parseArgs } from 'node:util';
import { TOOL_NAME, TOOL_VERSION } from './version.js';

export interface CliOptions {
  inputPath: string | null;
  outputDir: string;
  listOnly: boolean;
  includeBytecode: boolean;
  verbatim: boolean;
  json: boolean;
  showHelp: boolean;
  showVersion: boolean;
}

export const DEFAULT_OUTPUT_DIR = 'out';

export const HELP_TEXT = `${TOOL_NAME} ${TOOL_VERSION}
Extract the files packed inside a Bun single-file executable.

usage:
  bun-unpacker <binary> [options]

options:
  -o, --out <dir>   output directory (default: ./${DEFAULT_OUTPUT_DIR}). A universal binary
                    gets one sub-directory per architecture.
  -l, --list        print the embedded module table, write nothing
      --verbatim    write the files exactly as packed, leaving the references
                    to the packer's virtual filesystem in place. Without this,
                    those references are rewritten to point at the extracted
                    files, which is what makes the output runnable.
      --bytecode    also dump the JSC bytecode cache (very large, rarely useful)
      --json        print the manifest as JSON on stdout
  -v, --version     print the version of this tool
  -h, --help        this text`;

export class UsageError extends Error {}

/** Rethrows whatever parseArgs complains about as a usage error. */
export function asUsageError(error: unknown): never {
  throw new UsageError(error instanceof Error ? error.message : String(error));
}

/**
 * parseArgs accepts two values for `--out` that nobody wants: the empty string,
 * which resolves to the working directory, and the next flag, because an option
 * expecting a value swallows whatever token follows it.
 */
export function requireOutputDir(value: string | undefined): string {
  if (value === undefined) {
    return DEFAULT_OUTPUT_DIR;
  }
  if (value === '') {
    throw new UsageError('--out requires a directory name');
  }
  if (value.startsWith('-')) {
    throw new UsageError(`--out looks like a flag: ${value}`);
  }
  return value;
}

export function requireAtMostOneBinary(positionals: string[]): string | null {
  if (positionals.length > 1) {
    throw new UsageError(`expected at most one binary, got ${positionals.length}`);
  }
  return positionals[0] ?? null;
}

export function parseArguments(argv: string[]): CliOptions {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        out: { type: 'string', short: 'o' },
        list: { type: 'boolean', short: 'l' },
        verbatim: { type: 'boolean' },
        bytecode: { type: 'boolean' },
        json: { type: 'boolean' },
        version: { type: 'boolean', short: 'v' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (error) {
    asUsageError(error);
  }

  const { values, positionals } = parsed;
  return {
    inputPath: requireAtMostOneBinary(positionals),
    outputDir: requireOutputDir(values.out),
    listOnly: values.list ?? false,
    includeBytecode: values.bytecode ?? false,
    verbatim: values.verbatim ?? false,
    json: values.json ?? false,
    showHelp: values.help ?? false,
    showVersion: values.version ?? false,
  };
}
