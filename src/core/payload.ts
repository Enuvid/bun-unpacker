import type { BinaryReader } from './binary-reader.js';
import type { ImageSlice, ModuleEntry, ModuleTable, PayloadLayout, Region } from './types.js';

/**
 * Bun appends its payload to the end of the executable image and marks it with
 * this magic. The layout, from the start of the blob:
 *
 *   [ bytecode cache, file contents, sourcemaps, NUL-terminated names ]
 *   [ module table: moduleCount * entrySize                          ]
 *   [ offsets struct                                                 ]
 *   [ trailer magic                                                  ]
 *
 * Native metadata may follow the trailer (ELF section headers, a Mach-O code
 * signature), so the magic is not at the end of the file.
 */
export const PAYLOAD_TRAILER = Buffer.from('\n---- Bun! ----\n');

/**
 * Candidate sizes of the offsets struct, most likely first. Its first three
 * fields have been stable across Bun releases:
 *
 *   u64 blobSize, u32 moduleTableOffset, u32 moduleTableLength, ...
 *
 * The tail varies by version and is preserved verbatim in the manifest.
 */
const OFFSETS_STRUCT_SIZES = [32, 40, 24, 48, 28, 36, 20, 16];

/** Candidate module table strides, most likely first. */
const MODULE_ENTRY_SIZES = [52, 48, 44, 40, 36, 32, 56, 60, 64, 28, 24];

/** Field offsets within one module table entry. */
const ENTRY_NAME = 0;
const ENTRY_CONTENTS = 8;
const ENTRY_SOURCEMAP = 16;
const ENTRY_BYTECODE = 24;

const VIRTUAL_ROOT_PREFIXES = ['/$bunfs/root/', '/$bunfs/', 'B:\\~BUN\\root\\', 'B:/~BUN/root/'];

const MAX_NAME_LENGTH = 1024;
const MAX_MODULE_TABLE_LENGTH = 1 << 22;

// Matching control characters is the point: they are what separates a real
// packer path from a random run of bytes that happens to parse as a pointer.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/;

export class PayloadNotFoundError extends Error {}
export class PayloadParseError extends Error {}

/** Zero when the buffer stops short, which callers read as an absent field. */
function readUInt32(buffer: Buffer, offset: number): number {
  return offset + 4 <= buffer.length ? buffer.readUInt32LE(offset) : 0;
}

export function looksLikeVirtualPath(value: string): boolean {
  if (value.length === 0 || value.length > MAX_NAME_LENGTH) {
    return false;
  }
  if (CONTROL_CHARACTERS.test(value)) {
    return false;
  }
  return /bunfs|~BUN/i.test(value) || /^[/\\]/.test(value);
}

/** Turns `/$bunfs/root/src/entrypoints/cli.js` into `src/entrypoints/cli.js`. */
export function toRelativePath(name: string): string {
  let remainder = name;
  for (const prefix of VIRTUAL_ROOT_PREFIXES) {
    if (remainder.toLowerCase().startsWith(prefix.toLowerCase())) {
      remainder = remainder.slice(prefix.length);
      break;
    }
  }
  const segments = remainder
    .replace(/\\/g, '/')
    .split('/')
    .filter((segment) => segment !== '' && segment !== '.' && segment !== '..');
  return segments.length > 0 ? segments.join('/') : 'unnamed';
}

export function findPayloadTrailer(reader: BinaryReader, slice: ImageSlice): number {
  const sliceEnd = slice.start + slice.size;
  const offset = reader.findLast(PAYLOAD_TRAILER, slice.start, sliceEnd);
  if (offset === -1) {
    const header = reader.read(slice.start, 4096);
    const hint = header.includes(Buffer.from('NODE_SEA_BLOB'))
      ? ' (this looks like a Node.js single-executable binary, a different container)'
      : '';
    throw new PayloadNotFoundError(`no Bun payload trailer found${hint}`);
  }
  return offset;
}

/**
 * Tries each candidate struct size and keeps the first whose module table
 * resolves to a plausible packer path.
 */
export function readPayloadLayout(
  reader: BinaryReader,
  slice: ImageSlice,
  trailerOffset: number,
): PayloadLayout {
  const sliceEnd = slice.start + slice.size;
  const attempts: string[] = [];

  for (const offsetsStructSize of OFFSETS_STRUCT_SIZES) {
    const structStart = trailerOffset - offsetsStructSize;
    if (structStart < slice.start) {
      continue;
    }
    const struct = reader.read(structStart, offsetsStructSize);
    if (struct.length < 16) {
      continue;
    }

    const blobSize = Number(struct.readBigUInt64LE(0));
    const blobStart = structStart - blobSize;
    const moduleTableOffsetInBlob = readUInt32(struct, 8);
    const moduleTableLength = readUInt32(struct, 12);
    attempts.push(
      `size=${offsetsStructSize} blobSize=${blobSize} table=@${moduleTableOffsetInBlob}+${moduleTableLength}`,
    );

    if (!Number.isSafeInteger(blobSize) || blobSize <= 0 || blobSize > sliceEnd - slice.start) {
      continue;
    }
    if (blobStart < slice.start) {
      continue;
    }
    if (moduleTableLength === 0 || moduleTableLength > MAX_MODULE_TABLE_LENGTH) {
      continue;
    }
    if (moduleTableOffsetInBlob + moduleTableLength > blobSize) {
      continue;
    }

    const tableHead = reader.read(
      blobStart + moduleTableOffsetInBlob,
      Math.min(moduleTableLength, 64),
    );
    const nameOffset = readUInt32(tableHead, 0);
    const nameLength = readUInt32(tableHead, 4);
    if (nameLength === 0 || nameLength > MAX_NAME_LENGTH || nameOffset + nameLength > blobSize) {
      continue;
    }
    if (!looksLikeVirtualPath(reader.readText(blobStart + nameOffset, nameLength))) {
      continue;
    }

    return {
      trailerOffset,
      offsetsStructSize,
      offsetsStructHex: struct.toString('hex'),
      blobStart,
      blobSize,
      moduleTableOffsetInBlob,
      moduleTableLength,
    };
  }

  throw new PayloadParseError(
    `could not make sense of the Bun offsets struct. Tried:\n  ${attempts.join('\n  ')}`,
  );
}

export function readModuleTable(reader: BinaryReader, layout: PayloadLayout): ModuleTable {
  const { blobStart, blobSize, moduleTableOffsetInBlob, moduleTableLength } = layout;
  const table = reader.read(blobStart + moduleTableOffsetInBlob, moduleTableLength);

  const withinBlob = (region: Region): boolean => region.offset + region.length <= blobSize;

  const readRegion = (base: number, field: number): Region => ({
    offset: readUInt32(table, base + field),
    length: readUInt32(table, base + field + 4),
  });

  const optionalRegion = (base: number, field: number): Region | null => {
    const region = readRegion(base, field);
    return region.length > 0 && withinBlob(region) ? region : null;
  };

  for (const entrySize of MODULE_ENTRY_SIZES) {
    if (moduleTableLength % entrySize !== 0) {
      continue;
    }
    const moduleCount = moduleTableLength / entrySize;
    const modules: ModuleEntry[] = [];
    let strideFits = true;

    for (let index = 0; index < moduleCount && strideFits; index += 1) {
      const base = index * entrySize;
      const name = readRegion(base, ENTRY_NAME);
      if (name.length === 0 || name.length > MAX_NAME_LENGTH || !withinBlob(name)) {
        strideFits = false;
        break;
      }

      const moduleName = reader.readText(blobStart + name.offset, name.length);
      if (!looksLikeVirtualPath(moduleName)) {
        strideFits = false;
        break;
      }

      let contents = readRegion(base, ENTRY_CONTENTS);
      if (!withinBlob(contents)) {
        const recovered = findContentsAfterName(table, base, entrySize, name, withinBlob);
        if (recovered === null) {
          strideFits = false;
          break;
        }
        contents = recovered;
      } else if (contents.offset === 0 && contents.length === 0) {
        // Either a genuinely empty module or a layout that keeps the pointer
        // somewhere else in the entry. Prefer one that lands right after the
        // name, and fall back to the empty region rather than rejecting the
        // whole stride over a single empty file.
        contents = findContentsAfterName(table, base, entrySize, name, withinBlob) ?? contents;
      }

      modules.push({
        name: moduleName,
        contents,
        sourcemap: optionalRegion(base, ENTRY_SOURCEMAP),
        bytecode: optionalRegion(base, ENTRY_BYTECODE),
        rawEntryHex: table.subarray(base, base + entrySize).toString('hex'),
      });
    }

    if (strideFits && modules.length === moduleCount) {
      return { entrySize, modules };
    }
  }

  throw new PayloadParseError(
    `could not determine the module table stride (table is ${moduleTableLength} bytes)`,
  );
}

/**
 * The packer writes contents directly after the NUL-terminated name, so a
 * region starting at `nameEnd + 1` identifies the field even when it does not
 * sit at its usual offset.
 */
function findContentsAfterName(
  table: Buffer,
  base: number,
  entrySize: number,
  name: Region,
  withinBlob: (region: Region) => boolean,
): Region | null {
  const expectedOffset = name.offset + name.length + 1;
  for (let field = 8; field + 8 <= entrySize; field += 4) {
    const region = {
      offset: readUInt32(table, base + field),
      length: readUInt32(table, base + field + 4),
    };
    if (region.length > 0 && region.offset === expectedOffset && withinBlob(region)) {
      return region;
    }
  }
  return null;
}
