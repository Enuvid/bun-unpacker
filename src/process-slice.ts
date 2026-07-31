import { dirname, extname, join, resolve } from 'node:path';
import { rewriteReferences } from './rewrite.js';

/**
 * Only JavaScript. The substitution turns a string literal into an expression,
 * which is meaningless anywhere else: in JSON a value after a colon passes the
 * same check and rewriting it would produce a file that no longer parses.
 */
const REWRITABLE = new Set(['.js', '.mjs', '.cjs']);
import type { Payload, PayloadModule, ProcessOptions } from './types.js';

/**
 * Rewrites the packer's virtual filesystem references so the extracted files
 * can find each other, and returns a payload whose modules carry the patched
 * contents. Nothing is written here.
 *
 * `outputDir` has to be the same directory the payload is later written to:
 * the rewritten references are relative to where each file will land, so a
 * mismatch produces files that look fine and cannot find each other.
 */
export function processSlice(payload: Payload, options: ProcessOptions): Payload {
  if (!options.patchPaths) {
    return payload;
  }
  const outputRoot = resolve(options.outputDir);

  const modules: PayloadModule[] = payload.modules.map((module) => {
    if (!REWRITABLE.has(extname(module.path))) {
      return module;
    }

    const rewrite = { fileDirectory: dirname(join(outputRoot, module.path)), outputRoot };
    return {
      ...module,
      rewrite,
      // Reading the file is the caller's choice here. The writer never takes
      // it: it applies the same substitution chunk by chunk on the way out.
      bytes: () =>
        Buffer.from(
          rewriteReferences(module.bytes().toString('latin1'), rewrite.fileDirectory, outputRoot)
            .content,
          'latin1',
        ),
    };
  });

  return { ...payload, modules };
}
