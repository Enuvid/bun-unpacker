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
}

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

export interface ExtractedRegion extends Region {
  offsetInFile: number;
  writtenTo: string | null;
}

export interface ExtractedModule {
  name: string;
  /** Path relative to the output directory. */
  path: string;
  /** Human readable content type, e.g. `Mach-O arm64`. */
  kind: string;
  size: number;
  offsetInBlob: number;
  offsetInFile: number;
  /** Of the file on disk, which differs from `sha256Packed` once rewritten. */
  sha256: string | null;
  /** Of the bytes as they were packed, for verifying against the binary. */
  sha256Packed: string | null;
  /** Virtual filesystem references turned into `__dirname` expressions. */
  rewrittenReferences: number;
  writtenTo: string | null;
  sourcemap: ExtractedRegion | null;
  bytecode: ExtractedRegion | null;
  rawEntryHex: string;
}

export interface Manifest {
  tool: string;
  toolVersion: string;
  binary: {
    path: string;
    size: number;
    modifiedAt: string;
    container: ExecutableFormat;
    architecture: string | null;
    /** Set only when the binary is universal and this manifest covers one slice. */
    slice: { start: number; size: number } | null;
  };
  payload: PayloadLayout & {
    moduleEntrySize: number;
    moduleCount: number;
  };
  modules: ExtractedModule[];
}
