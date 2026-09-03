import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { BinaryReader } from '../../src/core/binary-reader.js';
import { inspectContainer } from '../../src/core/container.js';
import { processFile } from '../../src/core/process-slice.js';
import { readSlice } from '../../src/core/read-slice.js';
import { buildManifest, writeFile } from '../../src/core/write-slice-fs.js';
import { createRewriteStream, createRewriter, rewriteReferences } from '../../src/core/rewrite.js';
import type { Manifest } from '../../src/core/types.js';
import { type SyntheticModule, buildSyntheticExecutable } from '../helpers/synthetic.js';
import { createWorkspace } from '../helpers/workspace.js';

const workspace = createWorkspace('rewrite');
after(() => {
  rmSync(workspace, { recursive: true, force: true });
});

const BUNDLE_SOURCE = 'var asset="/$bunfs/root/assets/logo.txt";module.exports=asset;';

interface Extraction {
  manifest: Manifest;
  outputDir: string;
}

let counter = 0;
function extractModules(modules: SyntheticModule[], patchPaths: boolean): Extraction {
  counter += 1;
  const binary = join(workspace, `binary-${counter}`);
  writeFileSync(binary, buildSyntheticExecutable(modules).bytes);

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
        { patchPaths, includeBytecode: false },
      );
    })(),
    outputDir,
  };
}

function extract(patchPaths: boolean): Extraction {
  return extractModules(
    [
      { name: '/$bunfs/root/src/index.js', contents: Buffer.from(BUNDLE_SOURCE) },
      { name: '/$bunfs/root/assets/logo.txt', contents: Buffer.from('logo') },
    ],
    patchPaths,
  );
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

describe('choosing what to patch', () => {
  // A packed name is whatever the build called it, so it cannot be what
  // decides this. Claude Code renamed its entry point from
  // `src/entrypoints/cli.js` to `cli` between two releases, and every
  // reference in the one module that mattered silently stopped being patched.
  it('patches a bun module stored under a name with no extension', () => {
    const { manifest, outputDir } = extractModules(
      [
        {
          name: '/$bunfs/root/cli',
          contents: Buffer.from('// @bun @bytecode @bun-cjs\nvar a=("/$bunfs/root/asset.js");'),
        },
        { name: '/$bunfs/root/asset.js', contents: Buffer.from('module.exports=1;') },
      ],
      true,
    );

    const record = manifest.files[0];
    assert.equal(record?.kind, 'JS (bun cjs, bytecode-backed)', 'the kind was known all along');
    assert.equal(record?.rewrittenReferences, 1);

    const written = readFileSync(join(outputDir, 'cli'), 'utf8');
    assert.match(written, /\(__dirname\+"\/\.\/asset\.js"\)/);
    assert.doesNotMatch(written, /\$bunfs/);
  });

  // The other half of the same rule: a name cannot make something JavaScript
  // either. Rewriting a value here would leave a file that no longer parses,
  // and the reference sits in a position the position checks let through.
  it('leaves JSON alone, named as JSON or not named at all', () => {
    const json = '{"asset":"/$bunfs/root/asset.js"}';
    const { manifest, outputDir } = extractModules(
      [
        { name: '/$bunfs/root/config.json', contents: Buffer.from(json) },
        { name: '/$bunfs/root/config', contents: Buffer.from(json) },
      ],
      true,
    );

    assert.deepEqual(
      manifest.files.map((file) => [file.kind, file.rewrittenReferences]),
      [
        ['JSON', 0],
        ['data', 0],
      ],
    );
    assert.equal(readFileSync(join(outputDir, 'config.json'), 'utf8'), json);
    assert.equal(readFileSync(join(outputDir, 'config'), 'utf8'), json);
  });
});

describe('saying what patching did', () => {
  // Three ways to arrive at `rewrittenReferences: 0`, told apart only by the
  // outcome beside it. Separating them by hand is what this field exists to
  // save: nothing to patch, nothing to patch it in, and patched then reverted.
  it('tells the three ways of rewriting nothing apart', () => {
    const { manifest } = extractModules(
      [
        { name: '/$bunfs/root/quiet.js', contents: Buffer.from('console.log(1);') },
        { name: '/$bunfs/root/logo.txt', contents: Buffer.from('"/$bunfs/root/logo.txt"') },
        { name: '/$bunfs/root/keyed.js', contents: Buffer.from('var m={"/$bunfs/root/a.js":1};') },
      ],
      true,
    );

    assert.deepEqual(
      manifest.files.map((file) => [
        file.path,
        file.pathPatching,
        file.rewrittenReferences,
        file.skippedReferences,
      ]),
      [
        ['quiet.js', 'applied', 0, 0],
        ['logo.txt', 'not-applicable', 0, 0],
        ['keyed.js', 'reverted', 0, 1],
      ],
    );
  });

  it('counts what a file did have patched', () => {
    const { manifest } = extract(true);
    const record = manifest.files[0];
    assert.equal(record?.pathPatching, 'applied');
    assert.equal(record.rewrittenReferences, 1);
    assert.equal(record.skippedReferences, 0);
  });

  // With patching off every file reads `not-applicable`, exactly as a file
  // holding no JavaScript does. Only the manifest's own options separate them.
  it('records the options it was produced under', () => {
    const patched = extract(true);
    assert.deepEqual(patched.manifest.options, { patchPaths: true, includeBytecode: false });

    const asPacked = extract(false);
    assert.deepEqual(asPacked.manifest.options, { patchPaths: false, includeBytecode: false });
    assert.deepEqual(
      asPacked.manifest.files.map((file) => file.pathPatching),
      ['not-applicable', 'not-applicable'],
    );
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

describe('rewriting module specifiers', () => {
  // A static import or export names its module with a string literal and
  // nothing else: the grammar has no room for an expression there. A bundle
  // split into chunks is nearly all such references, and under the
  // all-or-nothing rule every chunk was written as packed because of them.
  it('turns each minified specifier form into a relative literal', () => {
    const forms: Array<[string, string]> = [
      ['import"/$bunfs/root/chunk-a.js";', 'import"./chunk-a.js";'],
      ['var x;import"/$bunfs/root/chunk-a.js";', 'var x;import"./chunk-a.js";'],
      ['import{a,b}from"/$bunfs/root/chunk-a.js";', 'import{a,b}from"./chunk-a.js";'],
      ['import a from"/$bunfs/root/chunk-a.js";', 'import a from"./chunk-a.js";'],
      ['import*as a from"/$bunfs/root/chunk-a.js";', 'import*as a from"./chunk-a.js";'],
      ['export{a}from"/$bunfs/root/chunk-a.js";', 'export{a}from"./chunk-a.js";'],
      ['export*from"/$bunfs/root/chunk-a.js";', 'export*from"./chunk-a.js";'],
      ['await import("/$bunfs/root/chunk-a.js")', 'await import("./chunk-a.js")'],
      ['require("/$bunfs/root/addon.node")', 'require("./addon.node")'],
      ['import "/$bunfs/root/chunk-a.js";', 'import "./chunk-a.js";'],
      ['import { a } from "/$bunfs/root/chunk-a.js";', 'import { a } from "./chunk-a.js";'],
      ['require ("/$bunfs/root/addon.node")', 'require ("./addon.node")'],
    ];
    for (const [source, expected] of forms) {
      const result = rewriteReferences(source, '/out', '/out', 'esm');
      assert.equal(result.content, expected, source);
      assert.equal(result.rewritten, 1, source);
      assert.equal(result.skipped, 0, source);
    }
  });

  it('prefixes the specifier with the way back up from a nested importer', () => {
    const result = rewriteReferences(
      'import{a}from"/$bunfs/root/chunk-a.js";',
      '/out/src/plugins/functionHooks/hooks-worker',
      '/out',
      'esm',
    );
    assert.equal(result.content, 'import{a}from"../../../../chunk-a.js";');
  });

  it('keeps a specifier a string whatever the module format', () => {
    for (const format of ['cjs', 'esm'] as const) {
      const result = rewriteReferences('require("/$bunfs/root/a.node")', '/out', '/out', format);
      assert.equal(result.content, 'require("./a.node")', format);
    }
  });

  it('does not take a property named like a keyword for one', () => {
    // As keys, `from` and `import` are followed by a colon, and the value
    // after that colon is a plain path in expression position.
    const result = rewriteReferences(
      'var o={from:"/$bunfs/root/a.txt",import:"/$bunfs/root/b.txt"};',
      '/out',
      '/out',
      'cjs',
    );
    assert.equal(
      result.content,
      'var o={from:(__dirname+"/./a.txt"),import:(__dirname+"/./b.txt")};',
    );
    assert.equal(result.rewritten, 2);
  });

  it('still leaves the whole file alone over a reference in key position', () => {
    const source = 'import"/$bunfs/root/a.js";var m={"/$bunfs/root/b.js":1};';
    const result = rewriteReferences(source, '/out', '/out', 'esm');
    assert.equal(result.content, source);
    assert.equal(result.rewritten, 0);
    assert.equal(result.skipped, 1);
  });
});

describe('choosing the directory expression', () => {
  it('uses import.meta.dirname in an ES module and __dirname in CommonJS', () => {
    const source = 'var a="/$bunfs/root/skill.md.zst";';
    assert.equal(
      rewriteReferences(source, '/out', '/out', 'esm').content,
      'var a=(import.meta.dirname+"/./skill.md.zst");',
    );
    assert.equal(
      rewriteReferences(source, '/out', '/out', 'cjs').content,
      'var a=(__dirname+"/./skill.md.zst");',
    );
  });

  it('assumes CommonJS when no format is given', () => {
    const result = rewriteReferences('var a="/$bunfs/root/x";', '/out', '/out');
    assert.equal(result.content, 'var a=(__dirname+"/./x");');
  });

  // The three files 0.11.0 did patch in Claude Code 2.1.259 were ES modules
  // holding nothing but expression-position references, and each crashed on
  // `__dirname` at runtime. The format has to come from the file itself, since
  // references like these give nothing away.
  it('patches an ES module whose references are all in expression position', () => {
    const { manifest, outputDir } = extractModules(
      [
        {
          name: '/$bunfs/root/chunk-a.js',
          contents: Buffer.from('// @bun @bytecode\nvar a="/$bunfs/root/skill.md.zst";export{a};'),
        },
        { name: '/$bunfs/root/skill.md.zst', contents: Buffer.from('zst') },
      ],
      true,
    );

    const record = manifest.files[0];
    assert.equal(record?.moduleFormat, 'esm');
    assert.equal(record.pathPatching, 'applied');
    assert.equal(record.rewrittenReferences, 1);
    assert.equal(
      readFileSync(join(outputDir, 'chunk-a.js'), 'utf8'),
      '// @bun @bytecode\nvar a=(import.meta.dirname+"/./skill.md.zst");export{a};',
    );
  });

  it('keeps __dirname for a module the packer marked as CommonJS', () => {
    const { manifest, outputDir } = extractModules(
      [
        {
          name: '/$bunfs/root/cli',
          contents: Buffer.from(
            '// @bun @bytecode @bun-cjs\n(function(exports, require, module, __filename, __dirname) {var a="/$bunfs/root/x.txt";})',
          ),
        },
      ],
      true,
    );

    assert.equal(manifest.files[0]?.moduleFormat, 'cjs');
    assert.match(readFileSync(join(outputDir, 'cli'), 'utf8'), /\(__dirname\+"\/\.\/x\.txt"\)/);
  });

  it('records no format for a file that is not JavaScript', () => {
    const { manifest } = extractModules(
      [{ name: '/$bunfs/root/notes.md', contents: Buffer.from('import x from "y"') }],
      true,
    );
    assert.equal(manifest.files[0]?.moduleFormat, null);
    assert.equal(manifest.files[0]?.pathPatching, 'not-applicable');
  });
});

describe('a bundle split into chunks', () => {
  // The shape of Claude Code 2.1.259: root-level chunks importing one another,
  // a worker in a subdirectory importing root chunks, an addon pulled in with
  // require, and a worker path kept as a plain string for `new Worker`.
  it('points every chunk at the others and at its assets', () => {
    const { manifest, outputDir } = extractModules(
      [
        {
          name: '/$bunfs/root/cli',
          contents: Buffer.from('// @bun @bytecode\nimport{u}from"/$bunfs/root/chunk-a.js";u();'),
        },
        {
          name: '/$bunfs/root/chunk-a.js',
          contents: Buffer.from(
            '// @bun @bytecode\nimport"/$bunfs/root/chunk-b.js";import{w}from"/$bunfs/root/chunk-b.js";' +
              'var u=()=>({HOOKS_WORKER_URL:"/$bunfs/root/src/worker/worker.js",n:require("/$bunfs/root/addon.node"),w});' +
              'export{u};',
          ),
        },
        {
          name: '/$bunfs/root/chunk-b.js',
          contents: Buffer.from('// @bun @bytecode\nvar w=1;export{w};'),
        },
        {
          name: '/$bunfs/root/src/worker/worker.js',
          contents: Buffer.from(
            '// @bun @bytecode\nimport{w}from"/$bunfs/root/chunk-b.js";await import("/$bunfs/root/chunk-a.js");',
          ),
        },
        { name: '/$bunfs/root/addon.node', contents: Buffer.from('\x7fELF') },
      ],
      true,
    );

    assert.deepEqual(
      manifest.files.map((file) => [file.path, file.pathPatching, file.skippedReferences]),
      [
        ['cli', 'applied', 0],
        ['chunk-a.js', 'applied', 0],
        ['chunk-b.js', 'applied', 0],
        ['src/worker/worker.js', 'applied', 0],
        ['addon.node', 'not-applicable', 0],
      ],
    );
    const written = (path: string): string => readFileSync(join(outputDir, path), 'utf8');
    assert.equal(written('cli'), '// @bun @bytecode\nimport{u}from"./chunk-a.js";u();');
    assert.equal(
      written('chunk-a.js'),
      '// @bun @bytecode\nimport"./chunk-b.js";import{w}from"./chunk-b.js";' +
        'var u=()=>({HOOKS_WORKER_URL:(import.meta.dirname+"/./src/worker/worker.js"),n:require("./addon.node"),w});' +
        'export{u};',
    );
    assert.equal(
      written('src/worker/worker.js'),
      '// @bun @bytecode\nimport{w}from"../../chunk-b.js";await import("../../chunk-a.js");',
    );
    for (const file of manifest.files) {
      assert.ok(!written(file.path).includes('$bunfs'), file.path);
    }
  });
});

describe('rewriting specifiers chunk by chunk', () => {
  function run(source: string, chunkSize: number): { output: string; rewritten: number } {
    const rewriter = createRewriter('/out/src', '/out', 'esm');
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

  const references = 'import"/$bunfs/root/a.js";import{x}from"/$bunfs/root/b.js";';
  const expected = 'import"../a.js";import{x}from"../b.js";';

  it('matches a specifier however the chunks fall across it', () => {
    const source = `${'x'.repeat(5000)};${references}${'y'.repeat(5000)}`;
    for (const chunkSize of [1, 7, 64, 1024, 4096, 5003, 5017, 10_000]) {
      const { output, rewritten } = run(source, chunkSize);
      assert.equal(rewritten, 2, `chunk size ${String(chunkSize)}`);
      assert.ok(output.includes(expected), `chunk size ${String(chunkSize)}`);
      assert.ok(!output.includes('$bunfs'), `chunk size ${String(chunkSize)}`);
    }
  });

  // The keyword before a specifier is what makes it one. Cut it off from the
  // string by a chunk boundary and the string would look like a bare literal,
  // be skipped, and revert the file. So the boundary is swept across the
  // keyword, the string and the context either side, and every position has
  // to give the same answer as the whole file. The semicolon matters: filler
  // running straight into `import` would make one long identifier of them.
  it('matches the whole-file result wherever the boundary falls', () => {
    const chunkSize = 4096;
    for (let padding = 1960; padding <= 2120; padding += 1) {
      const source = `${'x'.repeat(padding)};${references}${'y'.repeat(6000)}`;
      const { output, rewritten } = run(source, chunkSize);
      const whole = rewriteReferences(source, '/out/src', '/out', 'esm');
      assert.equal(output, whole.content, `padding ${String(padding)}`);
      assert.equal(rewritten, whole.rewritten, `padding ${String(padding)}`);
      assert.ok(output.includes(expected), `padding ${String(padding)} left a packed path`);
    }
  });

  it('carries the format through the transform', async () => {
    const source = `import"/$bunfs/root/a.js";var d="/$bunfs/root/skill.md";${'x'.repeat(9000)}`;
    const patch = createRewriteStream('/out', '/out', 'esm');
    const chunks: Uint8Array[] = [];
    const reader = new Blob([Buffer.from(source, 'latin1')])
      .stream()
      .pipeThrough(patch.stream)
      .getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      chunks.push(value);
    }
    const output = Buffer.concat(chunks).toString('latin1');
    assert.ok(output.startsWith('import"./a.js";var d=(import.meta.dirname+"/./skill.md");'));
    assert.deepEqual(patch.counts(), { rewritten: 2, skipped: 0 });
  });
});
