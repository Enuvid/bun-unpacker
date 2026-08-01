import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { BinaryReader } from '../../src/core/binary-reader.js';
import { inspectContainer } from '../../src/core/container.js';
import { MANIFEST_FILE_NAME, readSlice } from '../../src/core/read-slice.js';
import { buildManifest, writeFile, writeManifest } from '../../src/core/write-slice-fs.js';
import {
  PAYLOAD_TRAILER,
  PayloadNotFoundError,
  PayloadParseError,
  findPayloadTrailer,
  looksLikeVirtualPath,
  readModuleTable,
  readPayloadLayout,
  toRelativePath,
} from '../../src/core/payload.js';
import type { ImageSlice } from '../../src/core/types.js';
import { SYNTHETIC_ENTRY_SIZE, buildSyntheticExecutable } from '../helpers/synthetic.js';
import { createWorkspace } from '../helpers/workspace.js';

const workspace = createWorkspace('payload');
after(() => {
  rmSync(workspace, { recursive: true, force: true });
});

let temporaryFileCounter = 0;
function open(bytes: Buffer): BinaryReader {
  temporaryFileCounter += 1;
  const path = join(workspace, `binary-${temporaryFileCounter}`);
  writeFileSync(path, bytes);
  return BinaryReader.open(path);
}

function wholeFile(reader: BinaryReader): ImageSlice {
  const slice = inspectContainer(reader).slices[0];
  assert.ok(slice);
  return slice;
}

const SAMPLE_MODULES = [
  {
    name: '/$bunfs/root/src/entrypoints/cli.js',
    contents: Buffer.from('// @bun @bytecode @bun-cjs\n(function(){ return 1 })'),
    bytecode: Buffer.from('fake-bytecode-cache-contents'),
  },
  { name: '/$bunfs/root/assets/chart.min.js', contents: Buffer.from('console.log("chart")') },
  { name: '/$bunfs/root/native/addon.node', contents: Buffer.from('\x7fELF fake addon') },
];

describe('payload parsing', () => {
  it('decodes a synthetic executable end to end', () => {
    const synthetic = buildSyntheticExecutable(SAMPLE_MODULES);
    using reader = open(synthetic.bytes);
    const slice = wholeFile(reader);

    const trailerOffset = findPayloadTrailer(reader, slice);
    assert.equal(trailerOffset, synthetic.trailerOffset);

    const layout = readPayloadLayout(reader, slice, trailerOffset);
    assert.equal(layout.blobStart, synthetic.blobStart);
    assert.equal(layout.offsetsStructSize, 32);

    const { entrySize, modules } = readModuleTable(reader, layout);
    assert.equal(entrySize, SYNTHETIC_ENTRY_SIZE);
    assert.deepEqual(
      modules.map((module) => module.name),
      SAMPLE_MODULES.map((module) => module.name),
    );

    const [first, second] = modules;
    assert.ok(first && second);
    assert.equal(first.bytecode?.length, SAMPLE_MODULES[0]?.bytecode?.length);
    assert.equal(second.bytecode, null);
    assert.equal(first.sourcemap, null);
  });

  it('uses the last trailer, ignoring an earlier decoy', () => {
    // Bun's own runtime contains the trailer as a string literal, so a real
    // binary has more than one occurrence and only the last marks the payload.
    const prefix = Buffer.concat([Buffer.alloc(32), PAYLOAD_TRAILER, Buffer.alloc(32)]);
    const synthetic = buildSyntheticExecutable(SAMPLE_MODULES, { prefix });
    using reader = open(synthetic.bytes);
    assert.equal(findPayloadTrailer(reader, wholeFile(reader)), synthetic.trailerOffset);
  });

  it('finds the trailer when native metadata follows it', () => {
    const synthetic = buildSyntheticExecutable(SAMPLE_MODULES, {
      suffix: Buffer.alloc(64 * 1024, 0x41),
    });
    using reader = open(synthetic.bytes);
    assert.equal(findPayloadTrailer(reader, wholeFile(reader)), synthetic.trailerOffset);
  });

  it('finds a trailer straddling two scan windows', () => {
    const synthetic = buildSyntheticExecutable(SAMPLE_MODULES);
    using reader = open(synthetic.bytes);
    const windowSize = PAYLOAD_TRAILER.length + 3;
    assert.equal(
      reader.findLast(PAYLOAD_TRAILER, 0, reader.size, windowSize),
      synthetic.trailerOffset,
    );
  });

  it('probes struct sizes and table strides other than the current ones', () => {
    const synthetic = buildSyntheticExecutable(SAMPLE_MODULES, {
      entrySize: 40,
      offsetsStructSize: 40,
    });
    using reader = open(synthetic.bytes);
    const slice = wholeFile(reader);
    const layout = readPayloadLayout(reader, slice, findPayloadTrailer(reader, slice));

    assert.equal(layout.offsetsStructSize, 40);
    assert.equal(readModuleTable(reader, layout).entrySize, 40);
  });

  it('keeps an empty module instead of rejecting the whole table', () => {
    const synthetic = buildSyntheticExecutable([
      { name: '/$bunfs/root/empty.txt', contents: Buffer.alloc(0) },
      { name: '/$bunfs/root/cli.js', contents: Buffer.from('code') },
    ]);
    using reader = open(synthetic.bytes);
    const slice = wholeFile(reader);
    const { modules } = readModuleTable(
      reader,
      readPayloadLayout(reader, slice, findPayloadTrailer(reader, slice)),
    );

    assert.equal(modules.length, 2);
    assert.equal(modules[0]?.contents.length, 0);
    assert.equal(modules[1]?.contents.length, 4);
  });

  it('reports a missing payload instead of guessing', () => {
    using reader = open(Buffer.alloc(4096, 0x7a));
    assert.throws(() => findPayloadTrailer(reader, wholeFile(reader)), PayloadNotFoundError);
  });

  it('reports an unreadable module table instead of returning junk', () => {
    const synthetic = buildSyntheticExecutable(SAMPLE_MODULES);
    const corrupted = Buffer.from(synthetic.bytes);
    // Point the second entry's name outside the blob. No stride can explain it,
    // and the first entry still validates, so the failure lands in the table
    // reader rather than in the layout probe.
    const offsetsStructSize = 32;
    const tableStart =
      synthetic.trailerOffset - offsetsStructSize - SAMPLE_MODULES.length * SYNTHETIC_ENTRY_SIZE;
    corrupted.writeUInt32LE(0xffffff, tableStart + SYNTHETIC_ENTRY_SIZE);

    using reader = open(corrupted);
    const slice = wholeFile(reader);
    const layout = readPayloadLayout(reader, slice, findPayloadTrailer(reader, slice));
    assert.throws(() => readModuleTable(reader, layout), PayloadParseError);
  });
});

describe('extraction', () => {
  function extract(modules: typeof SAMPLE_MODULES, directory: string) {
    using reader = open(buildSyntheticExecutable(modules).bytes);
    const container = inspectContainer(reader);
    const slice = container.slices[0];
    assert.ok(slice);
    const payload = readSlice(reader, container, slice);
    return buildManifest(
      payload,
      payload.files.map((file) =>
        writeFile(reader, file, { outputDir: directory, includeBytecode: true }),
      ),
    );
  }

  it('writes every module verbatim and records matching hashes', () => {
    const outputDir = join(workspace, 'extracted');
    const manifest = extract(SAMPLE_MODULES, outputDir);

    assert.equal(manifest.payload.moduleEntrySize, SYNTHETIC_ENTRY_SIZE);
    for (const [index, sample] of SAMPLE_MODULES.entries()) {
      const record = manifest.files[index];
      assert.ok(record);
      assert.deepEqual(readFileSync(join(outputDir, record.path)), sample.contents);
      assert.equal(record.sha256, createHash('sha256').update(sample.contents).digest('hex'));
    }

    assert.deepEqual(
      readFileSync(join(outputDir, '_bytecode', 'src/entrypoints/cli.js.jsc')),
      SAMPLE_MODULES[0]?.bytecode,
    );
  });

  it('records paths relative to the output directory, not the process', () => {
    const manifest = extract(SAMPLE_MODULES, join(workspace, 'relative-paths'));
    for (const record of manifest.files) {
      assert.equal(record.writtenTo, record.path);
      assert.doesNotMatch(record.writtenTo ?? '', /^\.\./);
      // Forward slashes everywhere, so a manifest written on Windows matches
      // one written anywhere else.
      assert.doesNotMatch(record.writtenTo ?? '', /\\/);
    }
  });

  it('keeps traversal segments inside the output directory', () => {
    const outputDir = join(workspace, 'traversal');
    const manifest = extract(
      [{ name: '/$bunfs/root/../../escaped.js', contents: Buffer.from('nope') }],
      outputDir,
    );

    assert.equal(manifest.files[0]?.path, 'escaped.js');
    assert.ok(existsSync(join(outputDir, 'escaped.js')));
    assert.ok(!existsSync(join(workspace, 'escaped.js')));
  });

  it('never lets one module overwrite another', () => {
    const outputDir = join(workspace, 'collisions');
    const manifest = extract(
      [
        { name: '/$bunfs/root/cli.js', contents: Buffer.from('first') },
        { name: '/$bunfs/cli.js', contents: Buffer.from('second') },
      ],
      outputDir,
    );

    const paths = manifest.files.map((file) => file.path);
    assert.equal(new Set(paths).size, paths.length);
    assert.deepEqual(readFileSync(join(outputDir, paths[0] ?? '')), Buffer.from('first'));
    assert.deepEqual(readFileSync(join(outputDir, paths[1] ?? '')), Buffer.from('second'));
  });

  // A packed file is what the caller came for, so it keeps the name it had and
  // this tool's own output is what moves out of the way.
  it('leaves a packed file at its own path and drops the manifest instead', () => {
    const outputDir = join(workspace, 'manifest-clash');
    const manifest = extract(
      [{ name: `/$bunfs/root/${MANIFEST_FILE_NAME}`, contents: Buffer.from('packed') }],
      outputDir,
    );

    assert.equal(manifest.files[0]?.path, MANIFEST_FILE_NAME);
    assert.equal(writeManifest(manifest, outputDir), null);
    assert.deepEqual(readFileSync(join(outputDir, MANIFEST_FILE_NAME)), Buffer.from('packed'));
  });

  it('hands back the bytes without writing anything', () => {
    const outputDir = join(workspace, 'never-created');
    using reader = open(buildSyntheticExecutable(SAMPLE_MODULES).bytes);
    const container = inspectContainer(reader);
    const slice = container.slices[0];
    assert.ok(slice);

    const payload = readSlice(reader, container, slice);

    assert.equal(payload.files.length, SAMPLE_MODULES.length);
    for (const [index, sample] of SAMPLE_MODULES.entries()) {
      assert.deepEqual(payload.files[index]?.bytes(), sample.contents);
    }
    assert.ok(!existsSync(outputDir));
  });

  it('streams a module for callers that will not hold it in memory', async () => {
    using reader = open(buildSyntheticExecutable(SAMPLE_MODULES).bytes);
    const container = inspectContainer(reader);
    const slice = container.slices[0];
    assert.ok(slice);

    const module = readSlice(reader, container, slice).files[0];
    assert.ok(module);

    // getReader rather than async iteration. The stream itself is portable,
    // but iterating one is newer than the rest of the API and Safari has yet
    // to ship it, so this is what a consumer can rely on everywhere.
    const chunks: Uint8Array[] = [];
    const readerOfStream = module.stream().getReader();
    for (;;) {
      const { done, value } = await readerOfStream.read();
      if (done) {
        break;
      }
      chunks.push(value);
    }
    assert.deepEqual(Buffer.concat(chunks), SAMPLE_MODULES[0]?.contents);
  });
});

describe('virtual paths', () => {
  it('strips every packer root', () => {
    assert.equal(toRelativePath('/$bunfs/root/src/entrypoints/cli.js'), 'src/entrypoints/cli.js');
    assert.equal(toRelativePath('/$bunfs/mermaid.min.js'), 'mermaid.min.js');
    assert.equal(toRelativePath('B:\\~BUN\\root\\cli.js'), 'cli.js');
    assert.equal(toRelativePath('B:/~BUN/root/cli.js'), 'cli.js');
  });

  it('drops traversal segments', () => {
    assert.equal(toRelativePath('/$bunfs/root/../../etc/passwd'), 'etc/passwd');
    assert.equal(toRelativePath('/$bunfs/root/'), 'unnamed');
  });

  it('recognises packer paths and rejects noise', () => {
    assert.equal(looksLikeVirtualPath('/$bunfs/root/cli.js'), true);
    assert.equal(looksLikeVirtualPath('B:\\~BUN\\root\\cli.js'), true);
    assert.equal(looksLikeVirtualPath(''), false);
    assert.equal(looksLikeVirtualPath('plain-name.js'), false);
    assert.equal(looksLikeVirtualPath('/binary\u0000name'), false);
  });
});
