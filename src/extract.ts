import { createHash } from 'node:crypto';
import { closeSync, mkdirSync, openSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import type { BinaryReader } from './binary-reader.js';
import { HEADER_PROBE_SIZE, describeContents } from './container.js';
import {
  findPayloadTrailer,
  readModuleTable,
  readPayloadLayout,
  toRelativePath,
} from './payload.js';
import type {
  ContainerInfo,
  ExtractedModule,
  ExtractedRegion,
  ImageSlice,
  Manifest,
  Region,
} from './types.js';
import { TOOL_NAME, TOOL_VERSION } from './version.js';

const COPY_CHUNK_SIZE = 4 * 1024 * 1024;

export const MANIFEST_FILE_NAME = 'manifest.json';
const BYTECODE_DIRECTORY = '_bytecode';

export interface ExtractOptions {
  outputDir: string;
  /** When false nothing is written to disk; the manifest is still produced. */
  write: boolean;
  /** Dump the JSC bytecode cache alongside the sources. It is very large. */
  includeBytecode: boolean;
}

/** Streams a byte range to disk and returns its sha256. */
function copyRegion(
  reader: BinaryReader,
  absoluteOffset: number,
  length: number,
  destination: string,
): string {
  mkdirSync(dirname(destination), { recursive: true });
  const hash = createHash('sha256');
  const output = openSync(destination, 'w');
  try {
    let copied = 0;
    while (copied < length) {
      const chunk = reader.read(
        absoluteOffset + copied,
        Math.min(COPY_CHUNK_SIZE, length - copied),
      );
      if (chunk.length === 0) {
        throw new Error(`unexpected end of file while reading ${destination}`);
      }
      let written = 0;
      while (written < chunk.length) {
        written += writeSync(output, chunk, written, chunk.length - written);
      }
      hash.update(chunk);
      copied += chunk.length;
    }
  } catch (error) {
    closeSync(output);
    // Never leave a half-written file that looks like a successful extraction.
    rmSync(destination, { force: true });
    throw error;
  }
  closeSync(output);
  return hash.digest('hex');
}

/**
 * Two virtual paths can collapse onto one relative path, and a module could be
 * named after a file this tool writes itself. Either way the first writer wins
 * and the rest get a suffix, so nothing is silently overwritten.
 */
function uniquePath(candidate: string, taken: Set<string>): string {
  if (!taken.has(candidate)) {
    taken.add(candidate);
    return candidate;
  }
  const extension = extname(candidate);
  const stem = candidate.slice(0, candidate.length - extension.length);
  for (let suffix = 1; ; suffix += 1) {
    const alternative = `${stem}-${suffix}${extension}`;
    if (!taken.has(alternative)) {
      taken.add(alternative);
      return alternative;
    }
  }
}

/**
 * Manifest paths use forward slashes on every platform, so a manifest produced
 * on Windows compares equal to one produced anywhere else.
 */
function manifestPath(outputRoot: string, destination: string): string {
  return relative(outputRoot, destination).split(sep).join('/');
}

function toExtractedRegion(region: Region, blobStart: number): ExtractedRegion {
  return { ...region, offsetInFile: blobStart + region.offset, writtenTo: null };
}

/**
 * Parses one executable image and writes every embedded module below
 * `options.outputDir`, preserving the paths the packer recorded.
 */
export function extractSlice(
  reader: BinaryReader,
  container: ContainerInfo,
  slice: ImageSlice,
  options: ExtractOptions,
): Manifest {
  const trailerOffset = findPayloadTrailer(reader, slice);
  const layout = readPayloadLayout(reader, slice, trailerOffset);
  const { entrySize, modules } = readModuleTable(reader, layout);

  const outputRoot = resolve(options.outputDir);
  const takenPaths = new Set([MANIFEST_FILE_NAME, BYTECODE_DIRECTORY]);
  const extracted: ExtractedModule[] = [];

  const writeRegion = (region: ExtractedRegion, length: number, destination: string): void => {
    copyRegion(reader, region.offsetInFile, length, destination);
    region.writtenTo = manifestPath(outputRoot, destination);
  };

  for (const module of modules) {
    const relativePath = uniquePath(toRelativePath(module.name), takenPaths);
    const contentsOffsetInFile = layout.blobStart + module.contents.offset;
    const probe = reader.read(
      contentsOffsetInFile,
      Math.min(HEADER_PROBE_SIZE, module.contents.length),
    );

    const record: ExtractedModule = {
      name: module.name,
      path: relativePath,
      kind: describeContents(module.name, probe),
      size: module.contents.length,
      offsetInBlob: module.contents.offset,
      offsetInFile: contentsOffsetInFile,
      sha256: null,
      writtenTo: null,
      sourcemap: module.sourcemap ? toExtractedRegion(module.sourcemap, layout.blobStart) : null,
      bytecode: module.bytecode ? toExtractedRegion(module.bytecode, layout.blobStart) : null,
      rawEntryHex: module.rawEntryHex,
    };

    if (options.write) {
      const destination = join(outputRoot, relativePath);
      record.sha256 = copyRegion(reader, contentsOffsetInFile, module.contents.length, destination);
      record.writtenTo = manifestPath(outputRoot, destination);

      if (record.sourcemap) {
        writeRegion(record.sourcemap, record.sourcemap.length, `${destination}.map`);
      }
      if (record.bytecode && options.includeBytecode) {
        const bytecodePath = join(outputRoot, BYTECODE_DIRECTORY, `${relativePath}.jsc`);
        writeRegion(record.bytecode, record.bytecode.length, bytecodePath);
      }
    }

    extracted.push(record);
  }

  return {
    tool: TOOL_NAME,
    toolVersion: TOOL_VERSION,
    binary: {
      path: reader.filePath,
      size: reader.size,
      modifiedAt: reader.modifiedAt.toISOString(),
      container: container.format,
      architecture: slice.architecture ?? container.architecture,
      slice: container.isUniversal ? { start: slice.start, size: slice.size } : null,
    },
    payload: { ...layout, moduleEntrySize: entrySize, moduleCount: modules.length },
    modules: extracted,
  };
}

export function writeManifest(manifest: Manifest, outputDir: string): string {
  const outputRoot = resolve(outputDir);
  mkdirSync(outputRoot, { recursive: true });
  const destination = join(outputRoot, MANIFEST_FILE_NAME);
  writeFileSync(destination, `${JSON.stringify(manifest, null, 2)}\n`);
  return destination;
}
