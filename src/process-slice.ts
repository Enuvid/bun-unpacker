import { dirname, extname, join, resolve } from 'node:path';
import { rewriteReferences } from './rewrite.js';

/**
 * Only JavaScript. The substitution turns a string literal into an expression,
 * which is meaningless anywhere else: in JSON a value after a colon passes the
 * same check and rewriting it would produce a file that no longer parses.
 */
const REWRITABLE = new Set(['.js', '.mjs', '.cjs']);
import type { PayloadFile, ProcessOptions } from './types.js';

/**
 * Rewrites the packer's virtual filesystem references so the extracted files
 * can find each other, and returns a payload whose modules carry the patched
 * contents. Nothing is written here.
 *
 * `outputDir` has to be the same directory the payload is later written to:
 * the rewritten references are relative to where each file will land, so a
 * mismatch produces files that look fine and cannot find each other.
 */
/**
 * Marks one file whose packed references are to be rewritten. The substitution
 * itself happens when the bytes are read, so nothing is loaded here.
 *
 * `outputDir` has to be the directory the file is written to afterwards: the
 * references are rewritten relative to where it will land.
 */
export function processFile(file: PayloadFile, options: ProcessOptions): PayloadFile {
  if (!options.patchPaths || !REWRITABLE.has(extname(file.path))) {
    return file;
  }

  const outputRoot = resolve(options.outputDir);
  const rewrite = { fileDirectory: dirname(join(outputRoot, file.path)), outputRoot };

  return {
    ...file,
    rewrite,
    // Reading the file is the caller's choice here. The writer never takes it:
    // it applies the same substitution chunk by chunk on the way out.
    bytes: () =>
      Buffer.from(
        rewriteReferences(file.bytes().toString('latin1'), rewrite.fileDirectory, outputRoot)
          .content,
        'latin1',
      ),
  };
}
