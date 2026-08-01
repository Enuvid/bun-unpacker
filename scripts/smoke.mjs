// End-to-end check of the published entrypoint: build a synthetic Bun
// executable, run dist/cli.js against it the way a user would, and verify both
// the extracted bytes and the exit codes. Requires `npm run build` and
// `npm test` to have run first, since the binary builder lives in test-build/.
import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MANIFEST_FILE_NAME } from '../dist/index.js';
import { buildSyntheticExecutable } from '../test-build/test/helpers/synthetic.js';
import { createWorkspace } from '../test-build/test/helpers/workspace.js';

const CLI = 'dist/cli.js';
const PACKED_REFERENCE = 'var asset=("/$bunfs/root/logo.txt");';
const MODULE_CONTENTS = 'console.log(1)';

const workspace = createWorkspace('smoke');

function run(...args) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
}

function check(condition, description) {
  if (!condition) {
    throw new Error(`smoke check failed: ${description}`);
  }
  console.log(`ok  ${description}`);
}

try {
  const binary = join(workspace, 'synthetic-binary');
  writeFileSync(
    binary,
    buildSyntheticExecutable([
      { name: '/$bunfs/root/cli.js', contents: Buffer.from(MODULE_CONTENTS) },
      { name: '/$bunfs/root/asset-user.js', contents: Buffer.from(PACKED_REFERENCE) },
    ]).bytes,
  );

  const outputDir = join(workspace, 'out');
  const extraction = run(binary, '--out', outputDir);
  check(extraction.status === 0, `extraction exits 0 (got ${extraction.status})`);
  check(
    readFileSync(join(outputDir, 'cli.js'), 'utf8') === MODULE_CONTENTS,
    'extracted file matches the input byte for byte',
  );
  check(
    JSON.parse(readFileSync(join(outputDir, MANIFEST_FILE_NAME), 'utf8')).files.length === 2,
    'manifest lists both files',
  );

  const patched = readFileSync(join(outputDir, 'asset-user.js'), 'utf8');
  check(!patched.includes('$bunfs'), 'path patching leaves no packed reference behind');
  check(patched.includes('__dirname'), 'path patching points the reference at the output');

  const verbatimDir = join(workspace, 'verbatim');
  run(binary, '--out', verbatimDir, '--path-patching', 'false');
  check(
    readFileSync(join(verbatimDir, 'asset-user.js'), 'utf8') === PACKED_REFERENCE,
    '--path-patching false writes the file exactly as packed',
  );

  const notABinary = join(workspace, 'plain-file');
  writeFileSync(notABinary, Buffer.alloc(2048, 0x2e));
  check(run(notABinary).status === 1, 'a file with no payload exits 1');
  check(run('--nope').status === 2, 'an unknown flag exits 2');
  check(run('--version').stdout.trim().length > 0, '--version prints something');
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
