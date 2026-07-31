import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { BinaryReader } from '../src/binary-reader.js';
import {
  ContainerError,
  describeContents,
  detectArchitecture,
  detectFormat,
  inspectContainer,
  universalArchitectures,
} from '../src/container.js';
import { extractSlice } from '../src/extract.js';
import {
  buildSyntheticExecutable,
  elfHeader,
  machHeader,
  peHeader,
  universalHeader,
} from './helpers/synthetic.js';

const CPU_TYPE_I386 = 7;
const CPU_TYPE_X86_64 = 0x01000007;
const CPU_TYPE_ARM64 = 0x0100000c;
const CPU_TYPE_ARM64_32 = 0x0200000c;
const PE_MACHINE_X86_64 = 0x8664;
const PE_MACHINE_ARM64 = 0xaa64;
const UNIVERSAL_SLICE_ALIGNMENT = 0x4000;

const workspace = mkdtempSync(join(tmpdir(), 'bun-unpacker-container-'));
after(() => {
  rmSync(workspace, { recursive: true, force: true });
});

/** Packs complete images into a universal (fat) Mach-O container. */
function buildUniversalBinary(slices: { cpuType: number; bytes: Buffer }[]): Buffer {
  const alignUp = (value: number): number =>
    Math.ceil(value / UNIVERSAL_SLICE_ALIGNMENT) * UNIVERSAL_SLICE_ALIGNMENT;

  const offsets: number[] = [];
  let cursor = alignUp(8 + slices.length * 20);
  for (const slice of slices) {
    offsets.push(cursor);
    cursor = alignUp(cursor + slice.bytes.length);
  }

  const output = Buffer.alloc(cursor);
  output.writeUInt32BE(0xcafebabe, 0);
  output.writeUInt32BE(slices.length, 4);
  slices.forEach((slice, index) => {
    const base = 8 + index * 20;
    const offset = offsets[index] as number;
    output.writeUInt32BE(slice.cpuType, base);
    output.writeUInt32BE(0, base + 4);
    output.writeUInt32BE(offset, base + 8);
    output.writeUInt32BE(slice.bytes.length, base + 12);
    output.writeUInt32BE(14, base + 16);
    slice.bytes.copy(output, offset);
  });
  return output;
}

function write(name: string, bytes: Buffer): string {
  const path = join(workspace, name);
  writeFileSync(path, bytes);
  return path;
}

describe('executable format detection', () => {
  it('recognises every container Bun compiles to', () => {
    assert.equal(detectFormat(elfHeader(0x3e)), 'ELF');
    assert.equal(detectFormat(machHeader(CPU_TYPE_ARM64)), 'Mach-O');
    assert.equal(
      detectFormat(universalHeader([CPU_TYPE_X86_64, CPU_TYPE_ARM64])),
      'Mach-O universal',
    );
    assert.equal(detectFormat(peHeader(PE_MACHINE_X86_64)), 'PE');
    assert.equal(detectFormat(Buffer.from('MZ', 'latin1')), 'PE');
    assert.equal(detectFormat(Buffer.from('not an executable')), 'raw');
  });

  it('reads the architecture out of every header shape', () => {
    assert.equal(detectArchitecture(elfHeader(0x3e)), 'x86-64');
    assert.equal(detectArchitecture(elfHeader(0xb7)), 'arm64');
    assert.equal(detectArchitecture(machHeader(CPU_TYPE_ARM64)), 'arm64');
    assert.equal(detectArchitecture(machHeader(CPU_TYPE_X86_64)), 'x86-64');
    assert.equal(detectArchitecture(peHeader(PE_MACHINE_X86_64)), 'x86-64');
    assert.equal(detectArchitecture(peHeader(PE_MACHINE_ARM64)), 'arm64');
  });

  it('keeps 32-bit Mach-O architectures apart from their 64-bit namesakes', () => {
    assert.equal(detectArchitecture(machHeader(CPU_TYPE_I386)), 'i386');
    assert.equal(detectArchitecture(machHeader(CPU_TYPE_ARM64_32)), 'arm64_32');
  });

  it('admits it cannot tell rather than guessing', () => {
    // A DOS stub can push the COFF header past a truncated buffer.
    assert.equal(detectArchitecture(peHeader(PE_MACHINE_ARM64, 0x108).subarray(0, 0x80)), null);
    assert.equal(detectArchitecture(Buffer.from('not an executable')), null);
    assert.equal(detectArchitecture(elfHeader(0x99)), 'unknown:0x99');
  });

  it('lists the architectures of a universal header', () => {
    assert.deepEqual(universalArchitectures(universalHeader([CPU_TYPE_X86_64, CPU_TYPE_ARM64])), [
      'x86-64',
      'arm64',
    ]);
    assert.deepEqual(universalArchitectures(elfHeader(0x3e)), []);
  });
});

describe('embedded content descriptions', () => {
  it('reports the container and architecture of a native addon', () => {
    assert.equal(describeContents('addon.node', elfHeader(0xb7)), 'ELF arm64');
    assert.equal(describeContents('addon.node', machHeader(CPU_TYPE_ARM64)), 'Mach-O arm64');
    assert.equal(describeContents('addon.node', peHeader(PE_MACHINE_ARM64)), 'PE arm64');
    assert.equal(
      describeContents('addon.node', universalHeader([CPU_TYPE_X86_64, CPU_TYPE_ARM64])),
      'Mach-O universal (x86-64+arm64)',
    );
  });

  it('falls back to content markers, then to the extension', () => {
    assert.equal(
      describeContents('cli.js', Buffer.from('// @bun @bytecode @bun-cjs\n(function(){})')),
      'JS (bun cjs, bytecode-backed)',
    );
    assert.equal(
      describeContents('module.wasm', Buffer.from('0061736d01000000', 'hex')),
      'WebAssembly',
    );
    assert.equal(describeContents('archive.bin', Buffer.from('504b0304', 'hex')), 'zip archive');
    assert.equal(describeContents('data.json', Buffer.from('{"a":1}')), 'JSON');
    assert.equal(describeContents('mystery.bin', Buffer.from('????')), 'data');
  });
});

describe('universal binaries', () => {
  it('walks every slice and extracts each payload independently', () => {
    const intel = buildSyntheticExecutable([
      { name: '/$bunfs/root/cli.js', contents: Buffer.from('intel build') },
    ]);
    const apple = buildSyntheticExecutable([
      { name: '/$bunfs/root/cli.js', contents: Buffer.from('apple silicon build') },
      { name: '/$bunfs/root/extra.js', contents: Buffer.from('arm only module') },
    ]);

    const path = write(
      'universal-binary',
      buildUniversalBinary([
        { cpuType: CPU_TYPE_X86_64, bytes: intel.bytes },
        { cpuType: CPU_TYPE_ARM64, bytes: apple.bytes },
      ]),
    );

    using reader = BinaryReader.open(path);
    const container = inspectContainer(reader);
    assert.equal(container.isUniversal, true);
    assert.deepEqual(
      container.slices.map((slice) => slice.architecture),
      ['x86-64', 'arm64'],
    );

    const manifests = container.slices.map((slice) =>
      extractSlice(reader, container, slice, {
        outputDir: join(workspace, 'unused'),
        write: false,
        includeBytecode: false,
        verbatim: true,
      }),
    );

    assert.equal(manifests[0]?.modules.length, 1);
    assert.equal(manifests[1]?.modules.length, 2);
    assert.deepEqual(manifests[1]?.binary.slice, {
      start: container.slices[1]?.start,
      size: container.slices[1]?.size,
    });
  });

  it('refuses a header whose slices do not fit in the file', () => {
    const truncated = universalHeader([CPU_TYPE_X86_64]);
    truncated.writeUInt32BE(0x10000000, 8);
    truncated.writeUInt32BE(0x10000000, 12);

    using reader = BinaryReader.open(write('truncated-universal', truncated));
    assert.throws(() => inspectContainer(reader), ContainerError);
  });
});
