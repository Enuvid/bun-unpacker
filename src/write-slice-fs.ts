import { createHash } from 'node:crypto';
import { closeSync, mkdirSync, openSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type { BinaryReader } from './binary-reader.js';
import { BYTECODE_DIRECTORY, MANIFEST_FILE_NAME } from './read-slice.js';
import { createRewriter } from './rewrite.js';
import type {
  ExtractedModule,
  ExtractedRegion,
  Manifest,
  Payload,
  Region,
  WriteOptions,
} from './types.js';
import { TOOL_NAME, TOOL_VERSION } from './version.js';

const COPY_CHUNK_SIZE = 4 * 1024 * 1024;

interface CopyResult {
  sha256: string;
  rewritten: number;
  skipped: number;
}

/**
 * Copies a byte range to disk in chunks, rewriting packed references on the
 * way when asked, and returns the sha256 of what was written. The file is
 * never held in memory: the rewriter keeps back a couple of kilobytes so a
 * reference straddling a chunk boundary is still matched.
 */
function copyRegion(
  reader: BinaryReader,
  absoluteOffset: number,
  length: number,
  destination: string,
  rewrite: { fileDirectory: string; outputRoot: string } | null = null,
): CopyResult {
  mkdirSync(dirname(destination), { recursive: true });
  const hash = createHash('sha256');
  const rewriter = rewrite ? createRewriter(rewrite.fileDirectory, rewrite.outputRoot) : null;
  const output = openSync(destination, 'w');

  const emit = (bytes: Buffer): void => {
    let written = 0;
    while (written < bytes.length) {
      written += writeSync(output, bytes, written, bytes.length - written);
    }
    hash.update(bytes);
  };

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
      emit(rewriter ? rewriter.push(chunk) : chunk);
      copied += chunk.length;
    }
    if (rewriter) {
      emit(rewriter.end());
    }
  } catch (error) {
    closeSync(output);
    // Never leave a half-written file that looks like a successful extraction.
    rmSync(destination, { force: true });
    throw error;
  }
  closeSync(output);

  return { sha256: hash.digest('hex'), ...(rewriter?.counts() ?? { rewritten: 0, skipped: 0 }) };
}

/**
 * Manifest paths use forward slashes on every platform, so a manifest produced
 * on Windows compares equal to one produced anywhere else.
 */
function manifestPath(outputRoot: string, destination: string): string {
  return relative(outputRoot, destination).split(sep).join('/');
}

/** The packed bytes still have to be hashed when what was written differs. */
function hashRegion(reader: BinaryReader, absoluteOffset: number, length: number): string {
  const hash = createHash('sha256');
  for (let copied = 0; copied < length;) {
    const chunk = reader.read(absoluteOffset + copied, Math.min(COPY_CHUNK_SIZE, length - copied));
    hash.update(chunk);
    copied += chunk.length;
  }
  return hash.digest('hex');
}

function toExtractedRegion(region: Region, blobStart: number): ExtractedRegion {
  return { ...region, offsetInFile: blobStart + region.offset, writtenTo: null };
}

/**
 * Writes every module below `options.outputDir` and returns the record of what
 * was written. Patching happens here rather than in a step of its own because
 * it rewrites references to point at the destination: separating the two would
 * mean passing the same output directory twice, and a mismatch between them
 * would produce files that look fine and cannot find each other.
 */
export function writeSliceFs(payload: Payload, options: WriteOptions): Manifest {
  const { reader, layout } = payload;
  const outputRoot = resolve(options.outputDir);
  const extracted: ExtractedModule[] = [];

  const writeRegion = (region: ExtractedRegion, destination: string): void => {
    copyRegion(reader, region.offsetInFile, region.length, destination);
    region.writtenTo = manifestPath(outputRoot, destination);
  };

  for (const module of payload.modules) {
    const destination = join(outputRoot, module.path);
    const record: ExtractedModule = {
      name: module.name,
      path: module.path,
      kind: module.kind,
      size: module.size,
      offsetInBlob: module.offsetInBlob,
      offsetInFile: module.offsetInFile,
      sha256: null,
      sha256Packed: null,
      rewrittenReferences: 0,
      writtenTo: null,
      sourcemap: module.sourcemap ? toExtractedRegion(module.sourcemap, layout.blobStart) : null,
      bytecode: module.bytecode ? toExtractedRegion(module.bytecode, layout.blobStart) : null,
      rawEntryHex: module.rawEntryHex,
    };

    let copied = copyRegion(reader, module.offsetInFile, module.size, destination, module.rewrite);

    // All or nothing: one reference that could not be placed safely would leave
    // a file with a mix of working and broken paths. Rare enough to pay for
    // with a second copy rather than by buffering every file to find out.
    if (copied.skipped > 0) {
      copied = copyRegion(reader, module.offsetInFile, module.size, destination);
    }

    record.rewrittenReferences = copied.rewritten;
    record.sha256 = copied.sha256;
    record.sha256Packed =
      copied.rewritten > 0 ? hashRegion(reader, module.offsetInFile, module.size) : copied.sha256;
    record.writtenTo = manifestPath(outputRoot, destination);

    if (record.sourcemap) {
      writeRegion(record.sourcemap, `${destination}.map`);
    }
    if (record.bytecode && options.includeBytecode) {
      writeRegion(record.bytecode, join(outputRoot, BYTECODE_DIRECTORY, `${module.path}.jsc`));
    }

    extracted.push(record);
  }

  return {
    tool: TOOL_NAME,
    toolVersion: TOOL_VERSION,
    binary: payload.binary,
    payload: {
      ...layout,
      moduleEntrySize: payload.moduleEntrySize,
      moduleCount: payload.modules.length,
    },
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
