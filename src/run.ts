import { basename, join, relative, resolve } from 'node:path';
import { BinaryReader } from './binary-reader.js';
import { inspectContainer } from './container.js';
import { processSlice } from './process-slice.js';
import { readSlice } from './read-slice.js';
import { writeManifest, writeSliceFs } from './write-slice-fs.js';
import { formatBytes, renderTable } from './format.js';
import type { CliOptions } from './options.js';
import { HELP_TEXT, UsageError, parseArguments } from './options.js';
import type { Manifest, Payload } from './types.js';
import { TOOL_NAME, TOOL_VERSION } from './version.js';

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
      `${payload.fileCount} modules · ${payload.moduleEntrySize}-byte entries · ` +
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

export /** The manifest a payload would produce, for reporting without writing. */
function describePayload(payload: Payload): Manifest {
  return {
    tool: TOOL_NAME,
    toolVersion: TOOL_VERSION,
    binary: payload.binary,
    payload: {
      ...payload.layout,
      moduleEntrySize: payload.moduleEntrySize,
      fileCount: payload.files.length,
    },
    files: payload.files.map((file) => ({
      name: file.name,
      path: file.path,
      kind: file.kind,
      size: file.size,
      offsetInBlob: file.offsetInBlob,
      offsetInFile: file.offsetInFile,
      sha256: null,
      sha256Packed: null,
      rewrittenReferences: 0,
      writtenTo: null,
      sourcemap: file.sourcemap ? { ...file.sourcemap, writtenTo: null } : null,
      bytecode: file.bytecode ? { ...file.bytecode, writtenTo: null } : null,
      rawEntryHex: file.rawEntryHex,
    })),
  };
}

interface BinaryResult {
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
      const payload = processSlice(readSlice(reader, container, slice), {
        outputDir,
        // Listing writes nothing, so patching would only read every module
        // into memory for a report that never mentions it.
        patchPaths: options.patchPaths && !options.listOnly,
      });
      const manifest = options.listOnly
        ? describePayload(payload)
        : writeSliceFs(payload, { outputDir, includeBytecode: options.includeBytecode });
      if (!options.listOnly) {
        writeManifest(manifest, outputDir);
      }
      if (!options.json) {
        reportSlice(manifest, options, outputDir, streams);
      }
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
