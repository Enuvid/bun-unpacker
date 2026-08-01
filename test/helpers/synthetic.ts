import { PAYLOAD_TRAILER } from '../../src/payload.js';

/** Stride the current Bun releases use. The parser probes for it. */
export const SYNTHETIC_ENTRY_SIZE = 52;

const DEFAULT_OFFSETS_STRUCT_SIZE = 32;

export interface SyntheticModule {
  name: string;
  contents: Buffer;
  bytecode?: Buffer;
  sourcemap?: Buffer;
}

export interface SyntheticOptions {
  prefix?: Buffer;
  suffix?: Buffer;
  /** Both are probed by the parser, so tests need to vary them. */
  entrySize?: number;
  offsetsStructSize?: number;
}

export interface SyntheticExecutable {
  bytes: Buffer;
  blobStart: number;
  trailerOffset: number;
}

/**
 * Builds a stand-in for a Bun single-file executable: payload blob, module
 * table, offsets struct and trailer, wrapped in whatever prefix and suffix the
 * caller wants.
 */
export function buildSyntheticExecutable(
  modules: SyntheticModule[],
  options: SyntheticOptions = {},
): SyntheticExecutable {
  const prefix = options.prefix ?? Buffer.alloc(64);
  const suffix = options.suffix ?? Buffer.alloc(32);
  const entrySize = options.entrySize ?? SYNTHETIC_ENTRY_SIZE;
  const offsetsStructSize = options.offsetsStructSize ?? DEFAULT_OFFSETS_STRUCT_SIZE;

  const chunks: Buffer[] = [];
  let cursor = 0;

  const entries = modules.map((module) => {
    let bytecodeOffset = 0;
    let bytecodeLength = 0;
    if (module.bytecode !== undefined) {
      bytecodeOffset = cursor;
      bytecodeLength = module.bytecode.length;
      chunks.push(module.bytecode);
      cursor += module.bytecode.length;
    }

    const nameBytes = Buffer.from(module.name, 'utf8');
    const nameOffset = cursor;
    chunks.push(nameBytes, Buffer.from([0]));
    cursor += nameBytes.length + 1;

    const contentsOffset = cursor;
    chunks.push(module.contents);
    cursor += module.contents.length;

    let sourcemapOffset = 0;
    let sourcemapLength = 0;
    if (module.sourcemap !== undefined) {
      sourcemapOffset = cursor;
      sourcemapLength = module.sourcemap.length;
      chunks.push(module.sourcemap);
      cursor += module.sourcemap.length;
    }

    return {
      nameOffset,
      nameLength: nameBytes.length,
      contentsOffset,
      contentsLength: module.contents.length,
      bytecodeOffset,
      bytecodeLength,
      sourcemapOffset,
      sourcemapLength,
    };
  });

  const contentRegion = Buffer.concat(chunks);
  const table = Buffer.alloc(entries.length * entrySize);
  entries.forEach((entry, index) => {
    const base = index * entrySize;
    table.writeUInt32LE(entry.nameOffset, base + 0);
    table.writeUInt32LE(entry.nameLength, base + 4);
    table.writeUInt32LE(entry.contentsOffset, base + 8);
    table.writeUInt32LE(entry.contentsLength, base + 12);
    table.writeUInt32LE(entry.sourcemapOffset, base + 16);
    table.writeUInt32LE(entry.sourcemapLength, base + 20);
    if (base + 32 <= table.length) {
      table.writeUInt32LE(entry.bytecodeOffset, base + 24);
      table.writeUInt32LE(entry.bytecodeLength, base + 28);
    }
  });

  const blob = Buffer.concat([contentRegion, table]);
  const offsetsStruct = Buffer.alloc(offsetsStructSize);
  offsetsStruct.writeBigUInt64LE(BigInt(blob.length), 0);
  offsetsStruct.writeUInt32LE(contentRegion.length, 8);
  offsetsStruct.writeUInt32LE(table.length, 12);

  const bytes = Buffer.concat([prefix, blob, offsetsStruct, PAYLOAD_TRAILER, suffix]);
  return {
    bytes,
    blobStart: prefix.length,
    trailerOffset: prefix.length + blob.length + offsetsStructSize,
  };
}

/** A little-endian ELF header, enough for format and architecture detection. */
export function elfHeader(machine: number): Buffer {
  const header = Buffer.alloc(64);
  header.write('\x7fELF', 0, 'latin1');
  header[4] = 2;
  header[5] = 1;
  header[6] = 1;
  header.writeUInt16LE(2, 16);
  header.writeUInt16LE(machine, 18);
  return header;
}

export function machHeader(cpuType: number): Buffer {
  const header = Buffer.alloc(32);
  header.writeUInt32BE(0xcffaedfe, 0);
  header.writeUInt32LE(cpuType, 4);
  return header;
}

/**
 * `coffOffset` mirrors how far out real addons push the COFF header: 0x108 is
 * what real Windows addons use.
 */
export function peHeader(machine: number, coffOffset = 0x108): Buffer {
  const header = Buffer.alloc(coffOffset + 8);
  header.write('MZ', 0, 'latin1');
  header.writeUInt32LE(coffOffset, 0x3c);
  header.write('PE\0\0', coffOffset, 'latin1');
  header.writeUInt16LE(machine, coffOffset + 4);
  return header;
}

export function universalHeader(cpuTypes: number[]): Buffer {
  const header = Buffer.alloc(8 + cpuTypes.length * 20);
  header.writeUInt32BE(0xcafebabe, 0);
  header.writeUInt32BE(cpuTypes.length, 4);
  cpuTypes.forEach((cpuType, index) => {
    header.writeUInt32BE(cpuType, 8 + index * 20);
  });
  return header;
}
