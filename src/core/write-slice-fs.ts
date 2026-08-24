import { createHash } from 'node:crypto';
import { closeSync, mkdirSync, openSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type { BinaryReader } from './binary-reader.js';
import { MANIFEST_FILE_NAME } from './read-slice.js';
import { createRewriter } from './rewrite.js';
import type {
  ExtractedFile,
  ExtractedRegion,
  FileRegion,
  Manifest,
  ManifestOptions,
  PathPatching,
  Payload,
  PayloadFile,
  WriteOptions,
} from './types.js';
import { TOOL_NAME, TOOL_VERSION } from '../version.js';

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
    try {
      closeSync(output);
    } finally {
      // Never leave a half-written file that looks like a successful extraction.
      rmSync(destination, { force: true });
    }
    throw error;
  }
  closeSync(output);

  return { sha256: hash.digest('hex'), ...(rewriter?.counts() ?? { rewritten: 0, skipped: 0 }) };
}

/** The packed bytes still have to be hashed when what was written differs. */
function hashRegion(reader: BinaryReader, absoluteOffset: number, length: number): string {
  const hash = createHash('sha256');
  for (let copied = 0; copied < length;) {
    const chunk = reader.read(absoluteOffset + copied, Math.min(COPY_CHUNK_SIZE, length - copied));
    if (chunk.length === 0) {
      throw new Error('unexpected end of file while hashing packed bytes');
    }
    hash.update(chunk);
    copied += chunk.length;
  }
  return hash.digest('hex');
}

/**
 * Manifest paths use forward slashes on every platform, so a manifest produced
 * on Windows compares equal to one produced anywhere else.
 */
function manifestPath(outputRoot: string, destination: string): string {
  return relative(outputRoot, destination).split(sep).join('/');
}

function toExtractedRegion(region: FileRegion): ExtractedRegion {
  return { ...region, writtenTo: null };
}

/**
 * Which of the three outcomes a file met. Nothing else can reconstruct it: by
 * the time the record is built, a reverted file and a file with nothing to
 * patch both show zero rewritten references.
 */
function outcomeOf(rewrite: PayloadFile['rewrite'], skipped: number): PathPatching {
  if (rewrite === null) {
    return 'not-applicable';
  }
  return skipped > 0 ? 'reverted' : 'applied';
}

/**
 * Writes one file below `options.outputDir` and returns the record of it. The
 * reader is the one the payload was read through, since the bytes still come
 * from the binary rather than from memory.
 */
export function writeFile(
  reader: BinaryReader,
  file: PayloadFile,
  options: WriteOptions,
): ExtractedFile {
  const outputRoot = resolve(options.outputDir);
  const destination = join(outputRoot, file.path);

  let copied = copyRegion(reader, file.offsetInFile, file.size, destination, file.rewrite);
  // The second copy runs without a rewriter and so reports nothing skipped.
  // Keeping the first count is the only record that the revert happened.
  const skipped = copied.skipped;

  // All or nothing: one reference that could not be placed safely would leave a
  // file with a mix of working and broken paths. Rare enough to pay for with a
  // second copy rather than by buffering every file to find out.
  if (skipped > 0) {
    copied = copyRegion(reader, file.offsetInFile, file.size, destination);
  }

  const record: ExtractedFile = {
    name: file.name,
    path: file.path,
    kind: file.kind,
    size: file.size,
    offsetInBlob: file.offsetInBlob,
    offsetInFile: file.offsetInFile,
    rewrittenReferences: copied.rewritten,
    pathPatching: outcomeOf(file.rewrite, skipped),
    skippedReferences: skipped,
    sha256: copied.sha256,
    sha256Packed:
      copied.rewritten > 0 ? hashRegion(reader, file.offsetInFile, file.size) : copied.sha256,
    writtenTo: manifestPath(outputRoot, destination),
    sourcemap: file.sourcemap ? toExtractedRegion(file.sourcemap) : null,
    bytecode: file.bytecode ? toExtractedRegion(file.bytecode) : null,
    rawEntryHex: file.rawEntryHex,
  };

  if (record.sourcemap) {
    const sourcemapPath = join(outputRoot, record.sourcemap.path);
    copyRegion(reader, record.sourcemap.offsetInFile, record.sourcemap.length, sourcemapPath);
    record.sourcemap.writtenTo = manifestPath(outputRoot, sourcemapPath);
  }
  if (record.bytecode && options.includeBytecode) {
    const bytecodePath = join(outputRoot, record.bytecode.path);
    copyRegion(reader, record.bytecode.offsetInFile, record.bytecode.length, bytecodePath);
    record.bytecode.writtenTo = manifestPath(outputRoot, bytecodePath);
  }

  return record;
}

/** The record of a file that was not written, for reporting without writing. */
export function describeFile(file: PayloadFile): ExtractedFile {
  return {
    name: file.name,
    path: file.path,
    kind: file.kind,
    size: file.size,
    offsetInBlob: file.offsetInBlob,
    offsetInFile: file.offsetInFile,
    rewrittenReferences: 0,
    pathPatching: 'not-applicable',
    skippedReferences: 0,
    sha256: null,
    sha256Packed: null,
    writtenTo: null,
    sourcemap: file.sourcemap ? toExtractedRegion(file.sourcemap) : null,
    bytecode: file.bytecode ? toExtractedRegion(file.bytecode) : null,
    rawEntryHex: file.rawEntryHex,
  };
}

/**
 * Gathers records into a manifest, with the binary and payload they came from.
 *
 * `options` are the ones the records were produced under. They are not taken
 * from the records because they cannot be: a run with patching turned off
 * looks exactly like a payload holding no JavaScript.
 */
export function buildManifest(
  payload: Payload,
  files: ExtractedFile[],
  options: ManifestOptions,
): Manifest {
  return {
    tool: TOOL_NAME,
    toolVersion: TOOL_VERSION,
    binary: payload.binary,
    options,
    payload: {
      ...payload.layout,
      moduleEntrySize: payload.moduleEntrySize,
      fileCount: files.length,
    },
    files,
  };
}

/**
 * Writes the manifest beside the files, unless a packed file already landed on
 * that name. Packed content is what the caller came for, so it is never
 * written over; the manifest is this tool's own note and can be the one to go.
 * Returns where it was written, or null when it was not.
 */
export function writeManifest(manifest: Manifest, outputDir: string): string | null {
  if (manifest.files.some((file) => file.path === MANIFEST_FILE_NAME)) {
    return null;
  }
  const outputRoot = resolve(outputDir);
  mkdirSync(outputRoot, { recursive: true });
  const destination = join(outputRoot, MANIFEST_FILE_NAME);
  writeFileSync(destination, `${JSON.stringify(manifest, null, 2)}\n`);
  return destination;
}
