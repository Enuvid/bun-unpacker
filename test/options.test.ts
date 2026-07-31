import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_OUTPUT_DIR, UsageError, parseArguments } from '../src/options.js';

describe('argument parsing', () => {
  it('defaults to no binary and ./out', () => {
    const options = parseArguments([]);
    assert.equal(options.inputPath, null);
    assert.equal(options.outputDir, DEFAULT_OUTPUT_DIR);
    assert.equal(options.listOnly, false);
    assert.equal(options.includeBytecode, false);
  });

  it('accepts a binary path together with flags in any order', () => {
    const options = parseArguments([
      '--bytecode',
      '/tmp/app-binary',
      '-o',
      'dist/assets',
      '--list',
    ]);
    assert.equal(options.inputPath, '/tmp/app-binary');
    assert.equal(options.outputDir, 'dist/assets');
    assert.equal(options.includeBytecode, true);
    assert.equal(options.listOnly, true);
  });

  it('supports both spellings of every flag', () => {
    assert.equal(parseArguments(['-l']).listOnly, parseArguments(['--list']).listOnly);
    assert.equal(parseArguments(['-h']).showHelp, parseArguments(['--help']).showHelp);
    assert.equal(parseArguments(['-v']).showVersion, parseArguments(['--version']).showVersion);
    assert.equal(parseArguments(['-o', 'x']).outputDir, parseArguments(['--out=x']).outputDir);
  });

  it('takes a path that looks like a flag after --', () => {
    assert.equal(parseArguments(['--', '-weird-name']).inputPath, '-weird-name');
  });

  it('rejects unknown flags', () => {
    assert.throws(() => parseArguments(['--nope']), UsageError);
  });

  it('rejects --out without a usable value', () => {
    assert.throws(() => parseArguments(['-o']), UsageError);
    assert.throws(() => parseArguments(['--out=']), UsageError);
    // Without this, `-o --list` would create a directory named "--list".
    assert.throws(() => parseArguments(['-o', '--list']), UsageError);
  });

  it('rejects a second positional rather than silently picking one', () => {
    assert.throws(() => parseArguments(['first.bin', 'second.bin']), UsageError);
  });
});
