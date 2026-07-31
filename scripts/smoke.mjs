// End-to-end check of the published entrypoint: build a synthetic Bun
// executable, run dist/cli.js against it the way a user would, and verify both
// the extracted bytes and the exit codes. Requires `npm run build` and
// `npm test` to have run first, since the binary builder lives in test-build/.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSyntheticExecutable } from '../test-build/test/helpers/synthetic.js';

const CLI = 'dist/cli.js';
const MODULE_CONTENTS = 'console.log(1)';

const workspace = mkdtempSync(join(tmpdir(), 'bun-unpacker-smoke-'));

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
    JSON.parse(readFileSync(join(outputDir, 'manifest.json'), 'utf8')).files.length === 1,
    'manifest lists the file',
  );

  const notABinary = join(workspace, 'plain-file');
  writeFileSync(notABinary, Buffer.alloc(2048, 0x2e));
  check(run(notABinary).status === 1, 'a file with no payload exits 1');
  check(run('--nope').status === 2, 'an unknown flag exits 2');
  check(run('--version').stdout.trim().length > 0, '--version prints something');
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
