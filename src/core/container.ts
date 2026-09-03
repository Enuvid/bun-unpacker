import { extname } from 'node:path';
import type { BinaryReader } from './binary-reader.js';
import type { ContainerInfo, ExecutableFormat, ImageSlice, ModuleFormat } from './types.js';

const ELF_MACHINES: Readonly<Record<number, string>> = {
  0x03: 'i386',
  0x28: 'arm',
  0x3e: 'x86-64',
  0xb7: 'arm64',
  0xf3: 'riscv64',
};

const MACH_O_CPU_TYPES: Readonly<Record<number, string>> = {
  7: 'i386',
  12: 'arm',
  0x01000007: 'x86-64',
  0x0100000c: 'arm64',
  0x0200000c: 'arm64_32',
};

const PE_MACHINES: Readonly<Record<number, string>> = {
  0x014c: 'i386',
  0x01c4: 'arm',
  0x8664: 'x86-64',
  0xaa64: 'arm64',
};

/**
 * Mach-O magics as they read when the first four bytes are taken big-endian,
 * which makes both byte orders comparable without branching on endianness.
 */
const MACH_O_MAGIC_64_LITTLE = 0xcffaedfe;
const MACH_O_MAGIC_32_LITTLE = 0xcefaedfe;
const MACH_O_MAGIC_64_BIG = 0xfeedfacf;
const MACH_O_MAGIC_32_BIG = 0xfeedface;
const UNIVERSAL_MAGIC = 0xcafebabe;
const UNIVERSAL_MAGIC_64 = 0xcafebabf;

const MAX_UNIVERSAL_SLICES = 32;
const PE_POINTER_OFFSET = 0x3c;

/**
 * Enough to reach the COFF header behind a PE DOS stub: `e_lfanew` points past
 * it, and real addons push it as far out as 0x108.
 */
export const HEADER_PROBE_SIZE = 512;

export class ContainerError extends Error {}

function isElf(header: Buffer): boolean {
  return header.length >= 4 && header[0] === 0x7f && header.toString('latin1', 1, 4) === 'ELF';
}

function magic(header: Buffer): number | null {
  return header.length >= 4 ? header.readUInt32BE(0) : null;
}

function isMachO(value: number | null): boolean {
  return (
    value === MACH_O_MAGIC_64_LITTLE ||
    value === MACH_O_MAGIC_32_LITTLE ||
    value === MACH_O_MAGIC_64_BIG ||
    value === MACH_O_MAGIC_32_BIG
  );
}

function isUniversal(value: number | null): boolean {
  return value === UNIVERSAL_MAGIC || value === UNIVERSAL_MAGIC_64;
}

function architectureName(table: Readonly<Record<number, string>>, code: number): string {
  return table[code] ?? `unknown:0x${code.toString(16)}`;
}

export function detectFormat(header: Buffer): ExecutableFormat {
  if (isElf(header)) {
    return 'ELF';
  }
  const value = magic(header);
  if (isUniversal(value)) {
    return 'Mach-O universal';
  }
  if (isMachO(value)) {
    return 'Mach-O';
  }
  if (header.length >= 2 && header[0] === 0x4d && header[1] === 0x5a) {
    return 'PE';
  }
  return 'raw';
}

function elfArchitecture(header: Buffer): string | null {
  if (header.length < 20) {
    return null;
  }
  const littleEndian = header[5] === 1;
  const machine = littleEndian ? header.readUInt16LE(18) : header.readUInt16BE(18);
  return architectureName(ELF_MACHINES, machine);
}

function machArchitecture(header: Buffer): string | null {
  if (header.length < 8) {
    return null;
  }
  const value = header.readUInt32BE(0);
  const bigEndian = value === MACH_O_MAGIC_64_BIG || value === MACH_O_MAGIC_32_BIG;
  const cpuType = bigEndian ? header.readUInt32BE(4) : header.readUInt32LE(4);
  return architectureName(MACH_O_CPU_TYPES, cpuType >>> 0);
}

/** Null when `bytes` stops short of the COFF header the DOS stub points at. */
function peArchitecture(bytes: Buffer): string | null {
  if (bytes.length < PE_POINTER_OFFSET + 4) {
    return null;
  }
  const coffOffset = bytes.readUInt32LE(PE_POINTER_OFFSET);
  if (
    coffOffset + 6 > bytes.length ||
    bytes.toString('latin1', coffOffset, coffOffset + 2) !== 'PE'
  ) {
    return null;
  }
  return architectureName(PE_MACHINES, bytes.readUInt16LE(coffOffset + 4));
}

interface UniversalEntry extends ImageSlice {
  architecture: string;
}

/** Parses as many slice entries as `header` holds, ignoring truncated tails. */
function readUniversalEntries(header: Buffer): UniversalEntry[] {
  if (header.length < 12) {
    return [];
  }
  const value = header.readUInt32BE(0);
  if (!isUniversal(value)) {
    return [];
  }
  const sliceCount = header.readUInt32BE(4);
  if (sliceCount === 0 || sliceCount > MAX_UNIVERSAL_SLICES) {
    return [];
  }

  const wide = value === UNIVERSAL_MAGIC_64;
  const entrySize = wide ? 32 : 20;
  const entries: UniversalEntry[] = [];

  for (let index = 0; index < sliceCount; index += 1) {
    const offset = 8 + index * entrySize;
    if (offset + entrySize > header.length) {
      break;
    }
    entries.push({
      architecture: architectureName(MACH_O_CPU_TYPES, header.readUInt32BE(offset) >>> 0),
      start: wide ? Number(header.readBigUInt64BE(offset + 8)) : header.readUInt32BE(offset + 8),
      size: wide ? Number(header.readBigUInt64BE(offset + 16)) : header.readUInt32BE(offset + 12),
    });
  }
  return entries;
}

export function universalArchitectures(header: Buffer): string[] {
  return readUniversalEntries(header).map((entry) => entry.architecture);
}

export function detectArchitecture(header: Buffer): string | null {
  switch (detectFormat(header)) {
    case 'ELF':
      return elfArchitecture(header);
    case 'Mach-O':
      return machArchitecture(header);
    case 'Mach-O universal':
      return universalArchitectures(header).join('+') || null;
    case 'PE':
      return peArchitecture(header);
    default:
      return null;
  }
}

function readUniversalSlices(reader: BinaryReader, header: Buffer): ImageSlice[] {
  const sliceCount = header.readUInt32BE(4);
  const entrySize = header.readUInt32BE(0) === UNIVERSAL_MAGIC_64 ? 32 : 20;
  const table = reader.read(0, 8 + Math.min(sliceCount, MAX_UNIVERSAL_SLICES) * entrySize);
  return readUniversalEntries(table).filter(
    (entry) => entry.size > 0 && entry.start + entry.size <= reader.size,
  );
}

/** Identifies the executable and enumerates the images inside it. */
export function inspectContainer(reader: BinaryReader): ContainerInfo {
  const header = reader.read(0, HEADER_PROBE_SIZE);
  const format = detectFormat(header);

  if (format === 'Mach-O universal') {
    const slices = readUniversalSlices(reader, header);
    if (slices.length === 0) {
      throw new ContainerError('universal binary declares no slice that fits inside the file');
    }
    return {
      format,
      architecture: slices.map((slice) => slice.architecture).join('+'),
      slices,
      isUniversal: true,
    };
  }

  let architecture = detectArchitecture(header);
  if (architecture === null && format === 'PE' && header.length >= PE_POINTER_OFFSET + 4) {
    // A DOS stub longer than the probe pushes the COFF header out of reach.
    const coffOffset = header.readUInt32LE(PE_POINTER_OFFSET);
    const coff = reader.read(coffOffset, 6);
    if (coff.length === 6 && coff.toString('latin1', 0, 2) === 'PE') {
      architecture = architectureName(PE_MACHINES, coff.readUInt16LE(4));
    }
  }

  return {
    format,
    architecture,
    slices: [{ architecture, start: 0, size: reader.size }],
    isUniversal: false,
  };
}

const KIND_JAVASCRIPT = 'JavaScript';

/**
 * The kinds that come from the markers the packer leaves at the top of a
 * module it compiled itself. Those markers carry further than a name does: the
 * entry point is stored under whatever the build called it, which is as often
 * `cli` as `cli.js`.
 */
const KIND_BUN_JS = 'JS (bun)';
const KIND_BUN_CJS_BYTECODE = 'JS (bun cjs, bytecode-backed)';

const EXTENSION_KINDS: Readonly<Record<string, string>> = {
  '.js': KIND_JAVASCRIPT,
  '.mjs': KIND_JAVASCRIPT,
  '.cjs': KIND_JAVASCRIPT,
  '.json': 'JSON',
  '.wasm': 'WebAssembly',
  '.node': 'native addon',
  '.css': 'CSS',
  '.html': 'HTML',
  '.txt': 'text',
  '.md': 'markdown',
};

const BUN_BYTECODE_MARKER = '// @bun @bytecode @bun-cjs\n';

const JAVASCRIPT_KINDS: ReadonlySet<string> = new Set([
  KIND_JAVASCRIPT,
  KIND_BUN_JS,
  KIND_BUN_CJS_BYTECODE,
]);

export function describeContents(fileName: string, header: Buffer): string {
  const format = detectFormat(header);
  if (format === 'Mach-O universal') {
    const architectures = universalArchitectures(header);
    return architectures.length > 0
      ? `Mach-O universal (${architectures.join('+')})`
      : 'Mach-O universal';
  }
  if (format !== 'raw') {
    const architecture = detectArchitecture(header);
    return architecture === null ? format : `${format} ${architecture}`;
  }
  if (header.length >= 4 && header.toString('hex', 0, 4) === '0061736d') {
    return 'WebAssembly';
  }
  if (header.length >= 2 && header.toString('hex', 0, 2) === '504b') {
    return 'zip archive';
  }
  if (header.toString('utf8', 0, BUN_BYTECODE_MARKER.length) === BUN_BYTECODE_MARKER) {
    return KIND_BUN_CJS_BYTECODE;
  }
  if (header.toString('utf8', 0, 5) === '// @b') {
    return KIND_BUN_JS;
  }
  return EXTENSION_KINDS[extname(fileName).toLowerCase()] ?? 'data';
}

/**
 * Whether a file holds JavaScript, answered from the kind `describeContents`
 * arrived at rather than worked out a second time. Deciding it again from the
 * name is how a caller comes to disagree with the kind it was given, and the
 * name is the weaker of the two: packed names are whatever the build chose, so
 * an entry point stored as `cli` is as much JavaScript as one stored as
 * `cli.js` and only its contents say so.
 *
 * The name still gets a say, because two of the kinds that would outrank it
 * rest on a two-byte magic number. A bundle opening `MZ` or `PK` is an
 * executable or a zip by that measure and JavaScript by its extension, and on
 * those odds the extension is the better witness.
 */
export function isJavaScript(kind: string, fileName: string): boolean {
  return (
    JAVASCRIPT_KINDS.has(kind) ||
    EXTENSION_KINDS[extname(fileName).toLowerCase()] === KIND_JAVASCRIPT
  );
}

/**
 * The marker line the packer writes over a module it compiled itself, and the
 * flag it adds when that module is CommonJS. Without the flag the module is an
 * ES module, which is the packer's default.
 */
const BUN_MARKER = /^\/\/ @bun(?:\s|$)/;
const BUN_CJS_FLAG = '@bun-cjs';

const EXTENSION_FORMATS: Readonly<Record<string, ModuleFormat>> = {
  '.mjs': 'esm',
  '.cjs': 'cjs',
};

/**
 * Syntax only an ES module can hold: a static import or export at the start
 * of a statement, or `import.meta` anywhere. `import()` is left out, being
 * legal in both, and so is `require`, which Bun allows in either.
 */
const ESM_SYNTAX =
  /(?:^|[;}\n])\s*(?:import\s*(?:["'{*]|\s[\w$]+\s*(?:,|from\b))|export\s*(?:[{*]|(?:default|const|let|var|function|class|async)\b))|import\s*\.\s*meta\b/;

/**
 * Which module format a JavaScript file is written in, from its first bytes.
 *
 * The packer's marker settles it outright: it says `@bun-cjs` for CommonJS
 * and nothing for an ES module, and it is written from what the packer
 * actually emitted. Failing a marker, `.mjs` and `.cjs` are unambiguous by
 * definition. Failing both, a static import or export near the top says ESM.
 * Null when none of the three speaks, which the caller reads as CommonJS:
 * that is where a file with no markers at all was always treated as being.
 *
 * The header need only be the first few hundred bytes, and only the marker is
 * certain to sit there. The syntax check is the weakest of the three because
 * of it: a module whose first import comes after a long comment is missed.
 */
export function describeModuleFormat(fileName: string, header: Buffer): ModuleFormat | null {
  const text = header.toString('latin1');
  if (BUN_MARKER.test(text)) {
    const lineEnd = text.indexOf('\n');
    const marker = lineEnd === -1 ? text : text.slice(0, lineEnd);
    return marker.includes(BUN_CJS_FLAG) ? 'cjs' : 'esm';
  }
  const byExtension = EXTENSION_FORMATS[extname(fileName).toLowerCase()];
  if (byExtension !== undefined) {
    return byExtension;
  }
  return ESM_SYNTAX.test(text) ? 'esm' : null;
}
