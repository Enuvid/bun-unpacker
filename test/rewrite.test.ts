import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { BinaryReader } from '../src/binary-reader.js';
import { inspectContainer } from '../src/container.js';
import { processSlice } from '../src/process-slice.js';
import { readSlice } from '../src/read-slice.js';
import { writeSliceFs } from '../src/write-slice-fs.js';
import { rewriteReferences } from '../src/rewrite.js';
import type { Manifest } from '../src/types.js';
import { buildSyntheticExecutable } from './helpers/synthetic.js';

const workspace = mkdtempSync(join(tmpdir(), 'bun-unpacker-rewrite-'));
after(() => {
  rmSync(workspace, { recursive: true, force: true });
});

const BUNDLE_SOURCE = 'var asset="/$bunfs/root/assets/logo.txt";module.exports=asset;';

let counter = 0;
function extract(patchPaths: boolean): { manifest: Manifest; outputDir: string } {
  counter += 1;
  const binary = join(workspace, `binary-${counter}`);
  writeFileSync(
    binary,
    buildSyntheticExecutable([
      { name: '/$bunfs/root/src/index.js', contents: Buffer.from(BUNDLE_SOURCE) },
      { name: '/$bunfs/root/assets/logo.txt', contents: Buffer.from('logo') },
    ]).bytes,
  );

  const outputDir = join(workspace, `out-${counter}`);
  using reader = BinaryReader.open(binary);
  const container = inspectContainer(reader);
  const slice = container.slices[0];
  assert.ok(slice);

  return {
    manifest: writeSliceFs(
      processSlice(readSlice(reader, container, slice), { outputDir, patchPaths }),
      { outputDir, includeBytecode: false },
    ),
    outputDir,
  };
}

describe('rewriting packed references', () => {
  it('turns a reference into a path relative to the file that reads it', () => {
    const { manifest, outputDir } = extract(true);
    const written = readFileSync(join(outputDir, 'src/index.js'), 'utf8');

    assert.match(
      written,
      /\(__dirname \+ "\/\.\.\/assets\/logo\.txt"\)|\(__dirname\+"\/\.\.\/assets\/logo\.txt"\)/,
    );
    assert.doesNotMatch(written, /\$bunfs/);
    assert.equal(manifest.modules[0]?.rewrittenReferences, 1);
  });

  it('records both hashes, so the packed bytes stay verifiable', () => {
    const { manifest } = extract(true);
    const record = manifest.modules[0];
    assert.ok(record);

    assert.equal(record.sha256Packed, createHash('sha256').update(BUNDLE_SOURCE).digest('hex'));
    assert.notEqual(record.sha256, record.sha256Packed);
  });

  it('leaves the bytes alone with patching off, and both hashes agree', () => {
    const { manifest, outputDir } = extract(false);
    const record = manifest.modules[0];
    assert.ok(record);

    assert.equal(readFileSync(join(outputDir, 'src/index.js'), 'utf8'), BUNDLE_SOURCE);
    assert.equal(record.rewrittenReferences, 0);
    assert.equal(record.sha256, record.sha256Packed);
  });

  it('patches every JavaScript extension the packer might store', () => {
    for (const extension of ['js', 'mjs', 'cjs']) {
      const result = rewriteReferences(
        `var a=("/$bunfs/root/asset.${extension}");`,
        '/out',
        '/out',
      );
      assert.equal(result.rewritten, 1, extension);
    }
  });

  it('touches nothing that is not JavaScript', () => {
    const { manifest, outputDir } = extract(true);
    assert.equal(readFileSync(join(outputDir, 'assets/logo.txt'), 'utf8'), 'logo');
    assert.equal(manifest.modules[1]?.rewrittenReferences, 0);
  });
});

describe('rewriteReferences', () => {
  it('understands the Windows packer root as well', () => {
    const result = rewriteReferences('var a=("B:/~BUN/root/x.js");', '/out/src', '/out');
    assert.equal(result.rewritten, 1);
    assert.match(result.content, /__dirname\+"\/\.\.\/x\.js"/);
  });

  it('leaves a file alone when a reference is not in expression position', () => {
    // A key, or a string inside embedded data, cannot become an expression.
    const source = 'var map={"/$bunfs/root/a.js":1,"b":("/$bunfs/root/c.js")};';
    const result = rewriteReferences(source, '/out', '/out');

    assert.equal(result.content, source, 'all or nothing, so nothing');
    assert.equal(result.rewritten, 0);
    assert.equal(result.skipped, 1);
  });

  it('is a no-op on a file with no references', () => {
    const result = rewriteReferences('console.log(1)', '/out', '/out');
    assert.equal(result.rewritten, 0);
    assert.equal(result.skipped, 0);
  });
});
