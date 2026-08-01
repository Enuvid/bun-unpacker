import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { BinaryReader } from '../../src/core/binary-reader.js';
import { inspectContainer } from '../../src/core/container.js';
import { processFile } from '../../src/core/process-slice.js';
import { readSlice } from '../../src/core/read-slice.js';
import type { PayloadFile } from '../../src/core/types.js';
import { describeFile, writeFile } from '../../src/core/write-slice-fs.js';
import { type SyntheticModule, buildSyntheticExecutable } from '../helpers/synthetic.js';
import { createWorkspace } from '../helpers/workspace.js';

const workspace = createWorkspace('write');
const readers: BinaryReader[] = [];
after(() => {
  for (const reader of readers) {
    reader.close();
  }
  rmSync(workspace, { recursive: true, force: true });
});

let counter = 0;

interface Extraction {
  reader: BinaryReader;
  files: PayloadFile[];
  outputDir: string;
}

/** Writes a synthetic binary and reads its files back, one workspace per case. */
function extract(modules: SyntheticModule[]): Extraction {
  counter += 1;
  const binaryPath = join(workspace, `binary-${String(counter)}`);
  writeFileSync(binaryPath, buildSyntheticExecutable(modules).bytes);

  const reader = BinaryReader.open(binaryPath);
  readers.push(reader);
  const container = inspectContainer(reader);
  const slice = container.slices[0];
  assert.ok(slice);

  return {
    reader,
    files: readSlice(reader, container, slice).files,
    outputDir: join(workspace, `out-${String(counter)}`),
  };
}

describe('writeFile', () => {
  // The all-or-nothing rule only becomes real on disk here: a file with one
  // reference that cannot be placed safely has to land exactly as packed.
  it('falls back to the packed bytes when a reference cannot be placed', () => {
    const packed = Buffer.from('var a={"/$bunfs/root/asset.txt":1};');
    const { reader, files, outputDir } = extract([
      { name: '/$bunfs/root/cli.js', contents: packed },
    ]);
    const file = files[0];
    assert.ok(file);
    const record = writeFile(reader, processFile(file, { outputDir, patchPaths: true }), {
      outputDir,
      includeBytecode: false,
    });

    assert.equal(record.rewrittenReferences, 0);
    assert.equal(record.sha256, record.sha256Packed);
    assert.deepEqual(readFileSync(join(outputDir, record.path)), packed);
  });

  it('rewrites a reference that does sit in expression position', () => {
    const packed = Buffer.from('var a=("/$bunfs/root/asset.txt");');
    const { reader, files, outputDir } = extract([
      { name: '/$bunfs/root/cli.js', contents: packed },
    ]);
    const file = files[0];
    assert.ok(file);
    const record = writeFile(reader, processFile(file, { outputDir, patchPaths: true }), {
      outputDir,
      includeBytecode: false,
    });

    const written = readFileSync(join(outputDir, record.path), 'utf8');
    assert.equal(record.rewrittenReferences, 1);
    assert.ok(!written.includes('$bunfs'));
    assert.ok(written.includes('__dirname'));
    assert.notEqual(record.sha256, record.sha256Packed);
    assert.equal(record.sha256Packed, createHash('sha256').update(packed).digest('hex'));
  });

  // A packed file can be named after a sidecar the writer produces itself. The
  // packed one keeps the name: nothing in a bundle refers to a sidecar, so the
  // sidecar is the one that can afford to move.
  it('keeps a packed file at its name and moves the sourcemap instead', () => {
    const { reader, files, outputDir } = extract([
      { name: '/$bunfs/root/cli.js', contents: Buffer.from('x'), sourcemap: Buffer.from('MAP') },
      { name: '/$bunfs/root/cli.js.map', contents: Buffer.from('PACKED') },
    ]);
    const [source, clash] = files;
    assert.ok(source && clash);
    const records = [source, clash].map((file) =>
      writeFile(reader, file, { outputDir, includeBytecode: false }),
    );

    assert.equal(records[1]?.path, 'cli.js.map');
    assert.equal(source.sourcemap?.path, 'cli.js-1.map');
    assert.deepEqual(readFileSync(join(outputDir, 'cli.js.map')), Buffer.from('PACKED'));
    assert.deepEqual(readFileSync(join(outputDir, 'cli.js-1.map')), Buffer.from('MAP'));
  });

  it('moves the bytecode dump rather than the packed file', () => {
    const { files } = extract([
      { name: '/$bunfs/root/cli.js', contents: Buffer.from('x'), bytecode: Buffer.from('JSC') },
      { name: '/$bunfs/root/_bytecode/cli.js.jsc', contents: Buffer.from('PACKED') },
    ]);
    const [source, clash] = files;
    assert.ok(source && clash);

    assert.equal(clash.path, '_bytecode/cli.js.jsc');
    assert.equal(source.bytecode?.path, '_bytecode/cli.js-1.jsc');
  });
});

describe('describeFile', () => {
  it('reports a file without writing anything', () => {
    const { files } = extract([
      { name: '/$bunfs/root/cli.js', contents: Buffer.from('console.log(1)') },
    ]);
    const file = files[0];
    assert.ok(file);

    const record = describeFile(file);
    assert.equal(record.writtenTo, null);
    assert.equal(record.sha256, null);
    assert.equal(record.sha256Packed, null);
    assert.equal(record.rewrittenReferences, 0);
    assert.equal(record.path, file.path);
    assert.equal(record.kind, file.kind);
    assert.equal(record.size, file.size);
  });
});
