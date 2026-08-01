import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Walks up from the compiled helper until package.json turns up. */
function repositoryRoot(): string {
  let directory = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(directory, 'package.json'))) {
    const parent = dirname(directory);
    if (parent === directory) {
      throw new Error('no package.json above the test helper');
    }
    directory = parent;
  }
  return directory;
}

const TEMP_ROOT = join(repositoryRoot(), '.tmp');

/**
 * A scratch directory under the repository's gitignored `.tmp`, rather than the
 * system temp directory. Test output stays next to the project that made it,
 * and a failed run leaves it where you can look at it.
 */
export function createWorkspace(prefix: string): string {
  mkdirSync(TEMP_ROOT, { recursive: true });
  return mkdtempSync(join(TEMP_ROOT, `${prefix}-`));
}
