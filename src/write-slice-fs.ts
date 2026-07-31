import { createHash } from 'node:crypto';
import { closeSync, mkdirSync, openSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type { BinaryReader } from './binary-reader.js';
import { BYTECODE_DIRECTORY, MANIFEST_FILE_NAME } from './read-slice.js';
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

    record.sha256Packed = copyRegion(reader, module.offsetInFile, module.size, destination);
    record.sha256 = record.sha256Packed;
    record.writtenTo = manifestPath(outputRoot, destination);

    // A module that went through processSlice carries patched contents; the
    // packed bytes have already been hashed on their way to disk.
    if (module.rewrittenReferences > 0) {
      const patched = module.bytes();
      writeFileSync(destination, patched);
      record.sha256 = createHash('sha256').update(patched).digest('hex');
      record.rewrittenReferences = module.rewrittenReferences;
    }

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
