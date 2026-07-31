import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { TOOL_NAME, TOOL_VERSION } from '../src/version.js';

/** Walks up from the compiled test file until package.json turns up. */
function readPackageManifest(): { name: string; version: string } {
  let directory = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    try {
      return JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as {
        name: string;
        version: string;
      };
    } catch {
      const parent = dirname(directory);
      assert.notEqual(parent, directory, 'no package.json above the test file');
      directory = parent;
    }
  }
}

describe('package metadata', () => {
  it('keeps the tool name and version in sync with package.json', () => {
    const manifest = readPackageManifest();
    assert.equal(TOOL_VERSION, manifest.version, 'bump src/version.ts together with package.json');
    assert.equal(TOOL_NAME, manifest.name);
  });
});
