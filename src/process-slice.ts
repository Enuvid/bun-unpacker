import { Readable } from 'node:stream';
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

    const destination = join(outputRoot, module.path);
    const result = rewriteReferences(
      module.bytes().toString('utf8'),
      dirname(destination),
      outputRoot,
    );
    if (result.rewritten === 0) {
      return module;
    }

    const patched = Buffer.from(result.content, 'utf8');
    return {
      ...module,
      rewrittenReferences: result.rewritten,
      bytes: () => patched,
      stream: (region) => (region ? module.stream(region) : Readable.from(patched)),
    };
  });

  return { ...payload, modules };
}
