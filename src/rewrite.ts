import { relative, sep } from 'node:path';

/**
 * The packer records asset paths as absolute paths into a virtual filesystem
 * that exists only inside the compiled binary. Extracted files keep those
 * references, so the bundle looks for its assets somewhere that is not there.
 */
const VIRTUAL_ROOTS = [/^\/\$bunfs\/root\//i, /^B:[\\/]~BUN[\\/]root[\\/]/i];

/**
 * Case-insensitive to match the roots above. A reference the search finds but
 * the roots reject would count as skipped and, by the all-or-nothing rule,
 * leave a whole file unpatched.
 */
const REFERENCE = /"((?:\/\$bunfs\/root\/|B:[\\/]~BUN[\\/]root[\\/])[^"]+)"/gi;

/**
 * Only a literal in expression position can become an expression. The
 * preceding character is not enough to tell: in `{"a":1}` and `[x,"a":1]` a
 * key follows the same `{` or `,` an expression would. What settles it is the
 * character after the string, since a key is followed by a colon.
 */
const EXPRESSION_BEFORE = /[=(,:[?&|+{]\s*$/;
const KEY_AFTER = /^\s*:/;

/**
 * How much text either side of a match the two checks get to see. Both allow
 * whitespace between the literal and what decides it, so this also caps the
 * indentation they can look across: a literal further than this from its
 * operator is treated as unsafe, and the file is left as packed.
 */
const CONTEXT = 64;

/**
 * Bytes kept back between chunks. A reference can straddle a boundary, and the
 * checks either side of it need their context, so the tail has to exceed the
 * longest reference plus that context.
 */
const OVERLAP = 2048;

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
function substitute(content: string, fileDirectory: string, outputRoot: string): RewriteResult {
  const toRoot = relative(fileDirectory, outputRoot).split(sep).join('/') || '.';
  let rewritten = 0;
  let skipped = 0;

  const patched = content.replace(REFERENCE, (match, reference: string, offset: number) => {
    const asset = toAssetPath(reference);
    const before = content.slice(Math.max(0, offset - CONTEXT), offset);
    const after = content.slice(offset + match.length, offset + match.length + CONTEXT);
    if (asset === null || !EXPRESSION_BEFORE.test(before) || KEY_AFTER.test(after)) {
      skipped += 1;
      return match;
    }
    rewritten += 1;
    return `(__dirname+${JSON.stringify(`/${toRoot}/${asset}`)})`;
  });

  return { content: patched, rewritten, skipped };
}

export function rewriteReferences(
  content: string,
  fileDirectory: string,
  outputRoot: string,
): RewriteResult {
  const result = substitute(content, fileDirectory, outputRoot);

  // All or nothing: a file with one unrewritable reference would run with a
  // mix of working and broken paths, which is worse than leaving it as packed.
  return result.skipped > 0 ? { content, rewritten: 0, skipped: result.skipped } : result;
}

export interface ChunkRewriter {
  /** Bytes safe to emit; the rest is held back until the next chunk. */
  push: (chunk: Buffer) => Buffer;
  /** Whatever the tail still holds. */
  end: () => Buffer;
  readonly counts: () => { rewritten: number; skipped: number };
}

/**
 * The same substitution over a stream of chunks rather than a whole file.
 *
 * Latin-1 is deliberate: it maps every byte to one character and back, so
 * arbitrary UTF-8 content passes through untouched while the references, which
 * are ASCII, still match. Decoding as UTF-8 would have to handle a character
 * split across a chunk boundary for no gain.
 */
export function createRewriter(fileDirectory: string, outputRoot: string): ChunkRewriter {
  let tail = '';
  let rewritten = 0;
  let skipped = 0;

  const apply = (input: string): string => {
    const result = substitute(input, fileDirectory, outputRoot);
    rewritten += result.rewritten;
    skipped += result.skipped;
    return result.content;
  };

  /**
   * How far into `work` it is safe to substitute. A match ending near the end
   * may continue in the next chunk, and the check after a match needs its
   * context, so both stay behind.
   */
  const safeEnd = (work: string): number => {
    const limit = work.length - OVERLAP;
    const seen: Array<{ start: number; end: number }> = [];
    REFERENCE.lastIndex = 0;

    for (let match = REFERENCE.exec(work); match !== null; match = REFERENCE.exec(work)) {
      const start = match.index;
      const end = start + match[0].length;
      if (end + CONTEXT > limit) {
        // Leaving lastIndex where it stopped would make the next search on
        // this shared regex start from the middle of a later string.
        REFERENCE.lastIndex = 0;
        // Back off past the context as well: cutting flush against the match
        // would send the characters the check needs before it out with the
        // emitted bytes, and the deferred match would then look unsafe.
        let boundary = start - CONTEXT;
        // That backing off can land inside an earlier match that did fit. A
        // boundary through a string literal is the one cut this rewriter must
        // not make: neither half matches afterwards, so the reference survives
        // unpatched without counting as skipped, and the all-or-nothing rule
        // never fires. Keep stepping back until the boundary clears them all.
        for (let index = seen.length - 1; index >= 0; index -= 1) {
          const earlier = seen[index];
          if (earlier === undefined || earlier.end <= boundary) {
            break;
          }
          boundary = earlier.start - CONTEXT;
        }
        return Math.max(0, boundary);
      }
      seen.push({ start, end });
    }
    return limit;
  };

  return {
    push(chunk) {
      const work = tail + chunk.toString('latin1');
      // Below this there is not enough beyond the held-back tail to make
      // progress, so buffer rather than emitting a sliver at a time.
      if (work.length < OVERLAP * 2) {
        tail = work;
        return Buffer.alloc(0);
      }
      const boundary = safeEnd(work);
      tail = work.slice(boundary);
      return Buffer.from(apply(work.slice(0, boundary)), 'latin1');
    },
    end() {
      const remainder = tail;
      tail = '';
      return Buffer.from(apply(remainder), 'latin1');
    },
    counts: () => ({ rewritten, skipped }),
  };
}
