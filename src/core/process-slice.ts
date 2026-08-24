import { dirname, join, resolve } from 'node:path';
import { isJavaScript } from './container.js';
import { rewriteReferences } from './rewrite.js';
import type { PayloadFile, ProcessOptions } from './types.js';

/**
 * Marks one file whose packed references are to be rewritten. The substitution
 * itself happens when the bytes are read, so nothing is loaded here.
 *
 * `outputDir` has to be the directory the file is written to afterwards: the
 * references are rewritten relative to where it will land.
 *
 * Only JavaScript is touched. The substitution turns a string literal into an
 * expression, which is meaningless anywhere else: in JSON a value after a
 * colon passes the same check and rewriting it would produce a file that no
 * longer parses. What counts as JavaScript is `isJavaScript`'s to say, so the
 * kind reported for a file and the treatment it gets cannot disagree.
 */
export function processFile(file: PayloadFile, options: ProcessOptions): PayloadFile {
  if (!options.patchPaths || !isJavaScript(file.kind, file.path)) {
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
