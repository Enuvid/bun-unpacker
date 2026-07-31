import { relative, sep } from 'node:path';

/**
 * The packer records asset paths as absolute paths into a virtual filesystem
 * that exists only inside the compiled binary. Extracted files keep those
 * references, so the bundle looks for its assets somewhere that is not there.
 */
const VIRTUAL_ROOTS = [/^\/\$bunfs\/root\//, /^B:[\\/]~BUN[\\/]root[\\/]/i];

/**
 * Only a literal in expression position can become an expression. The
 * preceding character is not enough to tell: in `{"a":1}` and `[x,"a":1]` a
 * key follows the same `{` or `,` an expression would. What settles it is the
 * character after the string, since a key is followed by a colon.
 */
const EXPRESSION_BEFORE = /[=(,:[?&|+{]\s*$/;
const KEY_AFTER = /^\s*:/;

const REFERENCE = /"((?:\/\$bunfs\/root\/|B:[\\/]~BUN[\\/]root[\\/])[^"]+)"/gi;

export interface RewriteResult {
  content: string;
  /** How many references were turned into expressions. */
  rewritten: number;
  /** References that could not be rewritten safely; non-zero means nothing was. */
  skipped: number;
}

function toAssetPath(reference: string): string | null {
  for (const root of VIRTUAL_ROOTS) {
    if (root.test(reference)) {
      return reference.replace(root, '').replace(/\\/g, '/');
    }
  }
  return null;
}

/**
 * Rewrites virtual filesystem references to paths relative to the file doing
 * the reading, as `__dirname` expressions rather than plain strings.
 *
 * A relative string would not do: the bundle tests `isAbsolute` and falls back
 * to a directory from the build machine when the path is relative. An absolute
 * path would work but would pin the output to one location, whereas an
 * expression keeps the extracted directory movable.
 */
export function rewriteReferences(
  content: string,
  fileDirectory: string,
  outputRoot: string,
): RewriteResult {
  const total = content.match(REFERENCE)?.length ?? 0;
  if (total === 0) {
    return { content, rewritten: 0, skipped: 0 };
  }

  const toRoot = relative(fileDirectory, outputRoot).split(sep).join('/') || '.';
  let rewritten = 0;
  let skipped = 0;

  const patched = content.replace(REFERENCE, (match, reference: string, offset: number) => {
    const asset = toAssetPath(reference);
    const before = content.slice(Math.max(0, offset - 8), offset);
    const after = content.slice(offset + match.length, offset + match.length + 8);
    if (asset === null || !EXPRESSION_BEFORE.test(before) || KEY_AFTER.test(after)) {
      skipped += 1;
      return match;
    }
    rewritten += 1;
    return `(__dirname+${JSON.stringify(`/${toRoot}/${asset}`)})`;
  });

  // All or nothing: a file with one unrewritable reference would run with a
  // mix of working and broken paths, which is worse than leaving it as packed.
  return skipped > 0
    ? { content, rewritten: 0, skipped }
    : { content: patched, rewritten, skipped: 0 };
}
