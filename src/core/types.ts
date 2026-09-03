import type { BinaryReader } from './binary-reader.js';

/** A byte range inside the payload blob. */
export interface Region {
  /** Offset relative to the start of the payload blob. */
  offset: number;
  length: number;
}

export type ExecutableFormat = 'ELF' | 'Mach-O' | 'Mach-O universal' | 'PE' | 'raw';

/**
 * One executable image inside a file. Ordinary binaries have exactly one;
 * a universal (fat) Mach-O carries a full image per architecture, each with
 * its own payload.
 */
export interface ImageSlice {
  architecture: string | null;
  start: number;
  size: number;
}

export interface ContainerInfo {
  format: ExecutableFormat;
  architecture: string | null;
  slices: ImageSlice[];
  /** True when the file really is a universal binary, not a synthesised slice. */
  isUniversal: boolean;
}

/**
 * Offsets come in two flavours here: `trailerOffset` and `blobStart` are
 * absolute positions in the file, everything else is relative to `blobStart`.
 */
export interface PayloadLayout {
  trailerOffset: number;
  offsetsStructSize: number;
  offsetsStructHex: string;
  blobStart: number;
  blobSize: number;
  moduleTableOffsetInBlob: number;
  moduleTableLength: number;
  /**
   * Index into the module table of the module the packer starts with. Read
   * as stored, so it is only meaningful when it is below the module count.
   */
  entryPointId: number;
}

/**
 * How a JavaScript file names its own directory, which decides what a packed
 * path in expression position is rewritten in terms of: `__dirname` exists in
 * CommonJS and not in an ES module, `import.meta.dirname` the other way round.
 */
export type ModuleFormat = 'cjs' | 'esm';

export interface ModuleEntry {
  /** Path as stored by the packer, e.g. `/$bunfs/root/src/entrypoints/cli.js`. */
  name: string;
  contents: Region;
  sourcemap: Region | null;
  bytecode: Region | null;
  rawEntryHex: string;
}

export interface ModuleTable {
  entrySize: number;
  modules: ModuleEntry[];
}

/**
 * A region of the binary with its absolute position, so a file carries
 * everything needed to read it. `path` is where the region lands if it is
 * written out, resolved against the same names as the files themselves.
 */
export interface FileRegion extends Region {
  offsetInFile: number;
  path: string;
}

/** One embedded file, with access to its bytes. */
export interface PayloadFile {
  /** Path as the packer stored it, e.g. `/$bunfs/root/src/index.js`. */
  name: string;
  /** Where it lands relative to an output directory, collisions resolved. */
  path: string;
  kind: string;
  /**
   * For JavaScript, which of the two module formats the file is written in,
   * read from the packer's marker, the extension, or the syntax at the top.
   * Null for anything else, and for JavaScript none of those three settles.
   */
  moduleFormat: ModuleFormat | null;
  size: number;
  offsetInBlob: number;
  offsetInFile: number;
  sourcemap: FileRegion | null;
  bytecode: FileRegion | null;
  rawEntryHex: string;
  /**
   * Set by `processFile` when this file's references are to be rewritten. The
   * writer applies it chunk by chunk; `bytes()` applies it on demand.
   */
  rewrite: { fileDirectory: string; outputRoot: string; format: ModuleFormat } | null;
  /** Reads the whole file into memory. */
  bytes: () => Buffer;
  /**
   * For files too large to hold at once, such as the bytecode cache. Reads
   * through the payload's reader, so that reader has to stay open until the
   * stream is done.
   */
  stream: (region?: Region | null) => ReadableStream<Uint8Array>;
}

/** Everything one executable image holds, read but not written anywhere. */
export interface Payload {
  /** The payload is a view over this reader, which stays open for it. */
  reader: BinaryReader;
  binary: ManifestBinary;
  layout: PayloadLayout;
  /** Stride of the packer's module table, which is where these came from. */
  moduleEntrySize: number;
  files: PayloadFile[];
}

export interface ProcessOptions {
  /** Must match the directory the payload is written to afterwards. */
  outputDir: string;
  /** False returns the payload untouched, every module exactly as packed. */
  patchPaths: boolean;
}

export interface WriteOptions {
  outputDir: string;
  /** Dump the JSC bytecode cache alongside the sources. It is very large. */
  includeBytecode: boolean;
}

export interface ExtractedRegion extends Region {
  offsetInFile: number;
  path: string;
  writtenTo: string | null;
}

/**
 * What became of path patching for one file, which `rewrittenReferences` alone
 * cannot say: a count of zero is equally a file with nothing to patch, a file
 * patching does not apply to, and a file whose patch was reverted.
 *
 * `not-applicable` covers a file that holds no JavaScript and, when patching
 * was turned off, every file in the run. The manifest's `options` tells those
 * two apart.
 */
export type PathPatching = 'applied' | 'not-applicable' | 'reverted';

export interface ExtractedFile {
  name: string;
  /** Path relative to the output directory. */
  path: string;
  /** Human readable content type, e.g. `Mach-O arm64`. */
  kind: string;
  /** As on `PayloadFile`; it is what chose the directory expression. */
  moduleFormat: ModuleFormat | null;
  size: number;
  offsetInBlob: number;
  offsetInFile: number;
  /** Of the file on disk, which differs from `sha256Packed` once rewritten. */
  sha256: string | null;
  /** Of the bytes as they were packed, for verifying against the binary. */
  sha256Packed: string | null;
  /**
   * Virtual filesystem references pointed at the extracted files, whether as
   * relative module specifiers or as expressions on the module's directory.
   */
  rewrittenReferences: number;
  /** Which of the outcomes above left `rewrittenReferences` where it is. */
  pathPatching: PathPatching;
  /**
   * References the substitution could not place safely. Non-zero means the
   * file was written exactly as packed, whatever had been rewritten first.
   */
  skippedReferences: number;
  writtenTo: string | null;
  sourcemap: ExtractedRegion | null;
  bytecode: ExtractedRegion | null;
  rawEntryHex: string;
}

export interface ManifestBinary {
  path: string;
  size: number;
  modifiedAt: string;
  container: ExecutableFormat;
  architecture: string | null;
  /** Set only when the binary is universal and this manifest covers one slice. */
  slice: { start: number; size: number } | null;
}

/**
 * The options a manifest was produced under, without which its own numbers are
 * ambiguous: every file reads as `not-applicable` whether it holds no
 * JavaScript or patching was never asked for.
 */
export interface ManifestOptions {
  /** Whether packed references were pointed at the extracted files. */
  patchPaths: boolean;
  /** Whether the JSC bytecode cache was dumped alongside the sources. */
  includeBytecode: boolean;
}

export interface Manifest {
  tool: string;
  toolVersion: string;
  binary: ManifestBinary;
  options: ManifestOptions;
  payload: PayloadLayout & {
    moduleEntrySize: number;
    fileCount: number;
  };
  /**
   * The `path` of the file the packer starts with, or null when the packed
   * index points outside the table. It is not `files[0]`: a bundle split into
   * chunks stores them in whatever order the bundler emitted them.
   */
  entrypoint: string | null;
  files: ExtractedFile[];
}
