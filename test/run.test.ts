import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE, main } from '../src/run.js';
import type { Manifest } from '../src/types.js';
import { buildSyntheticExecutable } from './helpers/synthetic.js';

const workspace = mkdtempSync(join(tmpdir(), 'bun-unpacker-run-'));
after(() => {
  rmSync(workspace, { recursive: true, force: true });
});

const binaryPath = join(workspace, 'synthetic-binary');
writeFileSync(
  binaryPath,
  buildSyntheticExecutable([
    { name: '/$bunfs/root/cli.js', contents: Buffer.from('console.log(1)') },
    { name: '/$bunfs/root/assets/logo.txt', contents: Buffer.from('logo') },
  ]).bytes,
);

interface Captured {
  code: number;
  out: string;
  err: string;
}

function run(...argv: string[]): Captured {
  const out: string[] = [];
  const err: string[] = [];
  const code = main(argv, {
    out: (text) => out.push(text),
    err: (text) => err.push(text),
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

describe('cli', () => {
  it('prints usage and version without touching the filesystem', () => {
    const help = run('--help');
    assert.equal(help.code, EXIT_OK);
    assert.match(help.out, /usage:/);

    const version = run('--version');
    assert.equal(version.code, EXIT_OK);
    assert.match(version.out, /^\d+\.\d+\.\d+$/m);
  });

  it('separates usage errors from runtime failures', () => {
    assert.equal(run('--nope').code, EXIT_USAGE);
    assert.equal(run().code, EXIT_USAGE);
    assert.equal(run(join(workspace, 'does-not-exist')).code, EXIT_FAILURE);
  });

  it('fails when the input is not a Bun executable', () => {
    const plain = join(workspace, 'plain-file');
    writeFileSync(plain, Buffer.alloc(2048, 0x2e));

    const result = run(plain);
    assert.equal(result.code, EXIT_FAILURE);
    assert.match(result.err, /no Bun payload trailer found/);
  });

  it('extracts to the requested directory and writes a manifest', () => {
    const outputDir = join(workspace, 'cli-out');
    const result = run(binaryPath, '--out', outputDir);

    assert.equal(result.code, EXIT_OK);
    assert.equal(readFileSync(join(outputDir, 'cli.js'), 'utf8'), 'console.log(1)');
    assert.equal(readFileSync(join(outputDir, 'assets/logo.txt'), 'utf8'), 'logo');

    const manifest = JSON.parse(readFileSync(join(outputDir, 'manifest.json'), 'utf8')) as Manifest;
    assert.equal(manifest.files.length, 2);
    assert.match(result.out, /2 files/);
  });

  it('writes nothing under --list', () => {
    const outputDir = join(workspace, 'listed');
    const result = run(binaryPath, '--list', '--out', outputDir);

    assert.equal(result.code, EXIT_OK);
    assert.ok(!existsSync(outputDir));
    assert.match(result.out, /nothing written/);
  });

  it('always emits an array under --json, whatever the input count', () => {
    const result = run(binaryPath, '--json', '--out', join(workspace, 'json-out'));

    assert.equal(result.code, EXIT_OK);
    const manifests = JSON.parse(result.out) as Manifest[];
    assert.ok(Array.isArray(manifests));
    assert.equal(manifests.length, 1);
    assert.equal(manifests[0]?.files.length, 2);
  });
});
