import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { BinaryReader } from '../src/binary-reader.js';
import { inspectContainer } from '../src/container.js';
import { processFile } from '../src/process-slice.js';
import { readSlice } from '../src/read-slice.js';
import { buildManifest, writeFile } from '../src/write-slice-fs.js';
import { createRewriteStream, createRewriter, rewriteReferences } from '../src/rewrite.js';
import type { Manifest } from '../src/types.js';
import { buildSyntheticExecutable } from './helpers/synthetic.js';
import { createWorkspace } from './helpers/workspace.js';

const workspace = createWorkspace('rewrite');
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
    manifest: (() => {
      const payload = readSlice(reader, container, slice);
      return buildManifest(
        payload,
        payload.files.map((file) =>
          writeFile(reader, processFile(file, { outputDir, patchPaths }), {
            outputDir,
            includeBytecode: false,
          }),
        ),
      );
    })(),
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
    assert.equal(manifest.files[0]?.rewrittenReferences, 1);
  });

  it('records both hashes, so the packed bytes stay verifiable', () => {
    const { manifest } = extract(true);
    const record = manifest.files[0];
    assert.ok(record);

    assert.equal(record.sha256Packed, createHash('sha256').update(BUNDLE_SOURCE).digest('hex'));
    assert.notEqual(record.sha256, record.sha256Packed);
  });

  it('leaves the bytes alone with patching off, and both hashes agree', () => {
    const { manifest, outputDir } = extract(false);
    const record = manifest.files[0];
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
    assert.equal(manifest.files[1]?.rewrittenReferences, 0);
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

describe('rewriting chunk by chunk', () => {
  function run(source: string, chunkSize: number): { output: string; rewritten: number } {
    const rewriter = createRewriter('/out/src', '/out');
    const parts: Buffer[] = [];
    for (let offset = 0; offset < source.length; offset += chunkSize) {
      parts.push(rewriter.push(Buffer.from(source.slice(offset, offset + chunkSize), 'latin1')));
    }
    parts.push(rewriter.end());
    return {
      output: Buffer.concat(parts).toString('latin1'),
      rewritten: rewriter.counts().rewritten,
    };
  }

  const source = `${'x'.repeat(5000)}var a=("/$bunfs/root/asset.js");${'y'.repeat(5000)}`;

  it('matches a reference however the chunks fall across it', () => {
    // The interesting sizes are the ones that split the reference itself, and
    // the ones that split the context the checks either side of it need.
    for (const chunkSize of [1, 7, 64, 1024, 4096, 5017, 10_000]) {
      const { output, rewritten } = run(source, chunkSize);
      assert.equal(rewritten, 1, `chunk size ${chunkSize}`);
      assert.match(output, /__dirname\+"\/\.\.\/asset\.js"/);
      assert.doesNotMatch(output, /\$bunfs/);
    }
  });

  it('passes every other byte through untouched', () => {
    const { output } = run(source, 4096);
    assert.equal(
      output.length - source.length,
      '(__dirname+"/../asset.js")'.length - '"/$bunfs/root/asset.js"'.length,
    );
    assert.ok(output.startsWith('x'.repeat(5000)));
    assert.ok(output.endsWith('y'.repeat(5000)));
  });

  it('keeps binary content byte for byte across chunks', () => {
    const pattern = Buffer.from([0x00, 0xff, 0xfe, 0x80, 0x7f, 0xc3, 0x28]);
    const bytes = Buffer.concat(Array.from({ length: 2048 }, () => pattern));
    const rewriter = createRewriter('/out', '/out');
    const parts: Buffer[] = [];
    for (let offset = 0; offset < bytes.length; offset += 4096) {
      parts.push(rewriter.push(bytes.subarray(offset, offset + 4096)));
    }
    parts.push(rewriter.end());
    assert.deepEqual(Buffer.concat(parts), bytes);
  });

  // A chunk boundary must never cut through a string literal: neither half
  // matches afterwards, so the reference would survive unpatched without
  // counting as skipped, and the all-or-nothing rule would not fire.
  it('matches the whole-file result wherever the chunk boundary falls', () => {
    const references = '["/$bunfs/root/a.js","/$bunfs/root/b.js"]';
    const chunkSize = 4096;

    // The window brackets the first chunk's safe end, where a pair of adjacent
    // references can span the boundary with one side of it already emitted.
    for (let padding = 1960; padding <= 2120; padding += 1) {
      // The trailing filler keeps the source longer than one chunk, so the
      // rewriter actually reaches a boundary instead of buffering the lot.
      const source = `${'x'.repeat(padding)}${references};${'y'.repeat(6000)}`;
      const rewriter = createRewriter('/out', '/out');
      const parts: Buffer[] = [];
      for (let offset = 0; offset < source.length; offset += chunkSize) {
        parts.push(rewriter.push(Buffer.from(source.slice(offset, offset + chunkSize), 'latin1')));
      }
      parts.push(rewriter.end());

      const chunked = Buffer.concat(parts).toString('latin1');
      const whole = rewriteReferences(source, '/out', '/out');
      assert.equal(chunked, whole.content, `padding ${String(padding)}`);
      assert.deepEqual(rewriter.counts(), { rewritten: whole.rewritten, skipped: whole.skipped });
      assert.ok(!chunked.includes('$bunfs'), `padding ${String(padding)} left a packed path`);
    }
  });
});

describe('rewriting through a pipe', () => {
  /** Collects a stream the portable way, without async iteration. */
  async function collect(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
    const chunks: Uint8Array[] = [];
    const reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        return Buffer.concat(chunks);
      }
      chunks.push(value);
    }
  }

  function sourceOf(text: string, chunkSize: number): ReadableStream<Uint8Array> {
    let offset = 0;
    return new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset >= text.length) {
          controller.close();
          return;
        }
        controller.enqueue(Buffer.from(text.slice(offset, offset + chunkSize), 'latin1'));
        offset += chunkSize;
      },
    });
  }

  it('patches a file on the way through and counts what it did', async () => {
    const source = `var a=("/$bunfs/root/asset.txt");${'x'.repeat(9000)}`;
    const patch = createRewriteStream('/out/nested', '/out');

    const output = (await collect(sourceOf(source, 512).pipeThrough(patch.stream))).toString(
      'latin1',
    );

    assert.ok(!output.includes('$bunfs'));
    assert.ok(output.includes('(__dirname+"/../asset.txt")'));
    assert.deepEqual(patch.counts(), { rewritten: 1, skipped: 0 });
  });

  // The transform has no say over how much a source hands it at a time, and a
  // browser stream hands over far less than the writer does.
  it('gives the same result whatever the source chunk size', async () => {
    const source = `var a=("/$bunfs/root/a.js"),b=("/$bunfs/root/b.js");${'y'.repeat(7000)}`;
    const expected = rewriteReferences(source, '/out', '/out').content;

    for (const chunkSize of [1, 7, 512, 4096, 65536]) {
      const patch = createRewriteStream('/out', '/out');
      const output = await collect(sourceOf(source, chunkSize).pipeThrough(patch.stream));
      assert.equal(output.toString('latin1'), expected, `chunk size ${String(chunkSize)}`);
      assert.equal(patch.counts().rewritten, 2);
    }
  });

  it('passes bytes that are not text through untouched', async () => {
    const bytes = Buffer.concat(
      Array.from({ length: 1024 }, () => Buffer.from([0x00, 0xff, 0xfe, 0x80, 0x7f, 0xc3, 0x28])),
    );
    let offset = 0;
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset >= bytes.length) {
          controller.close();
          return;
        }
        controller.enqueue(bytes.subarray(offset, offset + 333));
        offset += 333;
      },
    });

    const patch = createRewriteStream('/out', '/out');
    assert.deepEqual(await collect(source.pipeThrough(patch.stream)), bytes);
  });
});
