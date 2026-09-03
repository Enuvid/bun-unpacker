import { basename, join, relative, resolve } from 'node:path';
import { BinaryReader } from '../core/binary-reader.js';
import { inspectContainer } from '../core/container.js';
import { processFile } from '../core/process-slice.js';
import { readSlice } from '../core/read-slice.js';
import { buildManifest, describeFile, writeFile, writeManifest } from '../core/write-slice-fs.js';
import { formatBytes, renderTable } from './format.js';
import type { CliOptions } from './options.js';
import { HELP_TEXT, UsageError, parseArguments } from './options.js';
import type { Manifest } from '../core/types.js';
import { TOOL_VERSION } from '../version.js';

export const EXIT_OK = 0;
export const EXIT_FAILURE = 1;
export const EXIT_USAGE = 2;

/** Injectable so tests, and wrappers around this CLI, can capture output. */
export interface Streams {
  out: (text: string) => void;
  err: (text: string) => void;
}

export const consoleStreams: Streams = {
  out: (text) => {
    console.log(text);
  },
  err: (text) => {
    console.error(text);
  },
};

export interface UnpackOptions {
  outputDir: string;
  listOnly: boolean;
  includeBytecode: boolean;
  patchPaths: boolean;
  json: boolean;
}

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function reportSlice(
  manifest: Manifest,
  options: UnpackOptions,
  outputDir: string,
  streams: Streams,
): void {
  const { payload, binary } = manifest;
  const label = binary.architecture
    ? `${binary.container} · ${binary.architecture}`
    : binary.container;

  streams.out(
    `${label} · payload ${formatBytes(payload.blobSize)} at 0x${payload.blobStart.toString(16)} · ` +
      `${payload.fileCount} files · ${payload.moduleEntrySize}-byte entries · ` +
      `trailer at 0x${payload.trailerOffset.toString(16)}`,
  );
  streams.out('');

  const rows = manifest.files.map((file) => [
    file.path,
    formatBytes(file.size),
    file.kind,
    file.bytecode ? formatBytes(file.bytecode.length) : '-',
  ]);
  for (const line of renderTable(['path', 'size', 'kind', 'bytecode'], rows, new Set([1]))) {
    streams.out(line);
  }

  const totalSize = manifest.files.reduce((total, file) => total + file.size, 0);
  streams.out(`\n  total extracted: ${formatBytes(totalSize)}`);
  // The file to run, which the table cannot say: a bundle split into chunks
  // stores its entry point wherever the bundler happened to put it.
  if (manifest.entrypoint !== null) {
    streams.out(`  entry point: ${manifest.entrypoint}`);
  }

  const bytecodeSize = manifest.files.reduce(
    (total, file) => total + (file.bytecode?.length ?? 0),
    0,
  );
  if (bytecodeSize > 0 && !options.includeBytecode) {
    streams.out(
      `  ${formatBytes(bytecodeSize)} of JSC bytecode skipped (pass --bytecode to dump it)`,
    );
  }

  if (options.listOnly) {
    streams.out('\n  --list: nothing written');
  } else {
    streams.out(`\n  written to ${relative(process.cwd(), resolve(outputDir)) || '.'}/`);
  }
  streams.out('');
}

/**
 * The one outcome that leaves a bundle looking extracted and not working. The
 * manifest records it either way; this is what puts it in front of somebody.
 */
export function reportReverts(manifest: Manifest, streams: Streams): void {
  for (const file of manifest.files) {
    if (file.pathPatching !== 'reverted') {
      continue;
    }
    const count = file.skippedReferences;
    streams.err(
      `warning: ${String(count)} reference${count === 1 ? '' : 's'} in ${file.path} could not be ` +
        'placed safely, so the file was written exactly as packed and its paths still point ' +
        'inside the binary',
    );
  }
}

export interface BinaryResult {
  manifests: Manifest[];
  failures: string[];
}

/** Unpacks one executable, reporting each slice as it goes. */
export function unpackBinary(
  filePath: string,
  options: UnpackOptions,
  streams: Streams,
): BinaryResult {
  using reader = BinaryReader.open(filePath);

  const container = inspectContainer(reader);
  if (!options.json) {
    streams.out(`\n${basename(filePath)}  ${formatBytes(reader.size)}  (${filePath})`);
  }

  const manifests: Manifest[] = [];
  const failures: string[] = [];

  for (const slice of container.slices) {
    const outputDir =
      container.slices.length > 1
        ? join(options.outputDir, slice.architecture ?? `slice-${slice.start}`)
        : options.outputDir;
    try {
      const payload = readSlice(reader, container, slice);
      const write = { outputDir, includeBytecode: options.includeBytecode };
      const processOptions = { outputDir, patchPaths: options.patchPaths };

      const manifest = buildManifest(
        payload,
        payload.files.map((file) =>
          options.listOnly
            ? describeFile(file)
            : writeFile(reader, processFile(file, processOptions), write),
        ),
        { patchPaths: options.patchPaths, includeBytecode: options.includeBytecode },
      );
      if (!options.listOnly) {
        writeManifest(manifest, outputDir);
      }
      if (!options.json) {
        reportSlice(manifest, options, outputDir, streams);
      }
      // After the report rather than through the middle of it, and on stderr,
      // so it survives `--json` and a redirected stdout alike.
      reportReverts(manifest, streams);
      manifests.push(manifest);
    } catch (error) {
      failures.push(`${slice.architecture ?? 'slice'}: ${describeError(error)}`);
    }
  }

  return { manifests, failures };
}

/** Distinct directory per target, even when two paths share a basename. */
function outputDirectoryFor(targets: string[], index: number, base: string): string {
  const target = targets[index];
  if (targets.length === 1 || target === undefined) {
    return base;
  }
  const name = basename(target);
  const earlierWithSameName = targets.some(
    (other, otherIndex) => otherIndex < index && basename(other) === name,
  );
  return join(base, earlierWithSameName ? `${name}-${index}` : name);
}

/**
 * Unpacks every target and returns the process exit code. Wrappers that supply
 * their own way of finding binaries reuse this instead of reimplementing the
 * loop, the per-target output directories and the JSON aggregation.
 */
export function unpackTargets(targets: string[], options: UnpackOptions, streams: Streams): number {
  const manifests: Manifest[] = [];
  let failures = 0;

  for (const [index, target] of targets.entries()) {
    const outputDir = outputDirectoryFor(targets, index, options.outputDir);
    try {
      const result = unpackBinary(target, { ...options, outputDir }, streams);
      manifests.push(...result.manifests);
      for (const failure of result.failures) {
        streams.err(`${target}: ${failure}`);
      }
      failures += result.failures.length;
    } catch (error) {
      streams.err(`${target}: ${describeError(error)}`);
      failures += 1;
    }
  }

  if (options.json) {
    streams.out(JSON.stringify(manifests, null, 2));
  }

  return failures > 0 ? EXIT_FAILURE : EXIT_OK;
}

export function main(argv: string[], streams: Streams = consoleStreams): number {
  let options: CliOptions;
  try {
    options = parseArguments(argv);
  } catch (error) {
    streams.err(describeError(error));
    return error instanceof UsageError ? EXIT_USAGE : EXIT_FAILURE;
  }

  if (options.showHelp) {
    streams.out(HELP_TEXT);
    return EXIT_OK;
  }
  if (options.showVersion) {
    streams.out(TOOL_VERSION);
    return EXIT_OK;
  }
  if (options.inputPath === null) {
    streams.err(`no binary given\n\n${HELP_TEXT}`);
    return EXIT_USAGE;
  }

  return unpackTargets([resolve(options.inputPath)], options, streams);
}
