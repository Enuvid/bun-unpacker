# bun-unpacker

[![CI](https://github.com/Enuvid/bun-unpacker/actions/workflows/ci.yml/badge.svg)](https://github.com/Enuvid/bun-unpacker/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/bun-unpacker)](https://www.npmjs.com/package/bun-unpacker)

📦 Extract the files packed into a `bun build --compile` executable: the
JavaScript bundle, native addons, sourcemaps and assets. This is unpacking
rather than decompiling a Bun binary: the files are embedded whole, so they are
copied out byte for byte rather than reconstructed from machine code.

It began as research into how Claude Code is packed, and works on any Bun
executable.

## 🚀 Quick start

Claude Code is the example here, and any other `bun build --compile`
executable works the same way. See what is inside:

```console
$ npx bun-unpacker $(which claude) --list

claude  206.6 MB  (/home/you/.local/bin/claude)
ELF · x86-64 · payload 123.3 MB at 0x533f008 · 1819 files · 52-byte entries · trailer at 0xce95fd5

  path                                                        size  kind        bytecode
  ------------------------------------------------------  --------  ----------  --------
  chunk-56nvyfje.js                                        1.13 KB  JS (bun)    1.84 KB
  chunk-97tbrkcc.js                                        1.03 KB  JS (bun)    2.04 KB
  chunk-egazc1xn.js                                        2.61 KB  JS (bun)    5.14 KB
  chunk-qdy5nfrc.js                                        1.11 KB  JS (bun)    616 B
  chunk-qjp61mp4.js                                        2.43 KB  JS (bun)    1.87 KB
  cli                                                      19.2 KB  JS (bun)    63.9 KB
  ...
  src/plugins/functionHooks/hooks-worker/hooks-worker.js   5.06 KB  JS (bun)    18.2 KB
  ...
  image-processor.node                                     1.40 MB  ELF x86-64  -
  ...
  mermaid.min.js                                          767.4 KB  JavaScript  -
  ...
  template-eg8004mh.md                                     4.00 KB  markdown    -

  total extracted: 37.1 MB
  entry point: cli
  72.4 MB of JSC bytecode skipped (pass --bytecode to dump it)

  --list: nothing written
```

The table runs to 1819 rows and is cut here. Extract:

```sh
npx bun-unpacker $(which claude)                       # extract to ./out
npx bun-unpacker $(which claude) -o claude-unpacked    # explicit target
```

Run the unpacked JS. The file to run is the one the report names as
`entry point`, and the manifest records it as `entrypoint`, so the command
can read it from there rather than know it:

```console
$ bun "claude-unpacked/$(bun -p 'require("./claude-unpacked/__unpack_manifest.json").entrypoint')" --version
2.1.259 (Claude Code)
```

Here that is `bun claude-unpacked/cli --version`.

Paths inside JS files are patched during extraction, so the assets can load.
Pass `--path-patching false` to get every file exactly as packed.

The JavaScript is a minified bundle, so what you get is what was shipped rather
than anything comfortable to read. It also stays under the license of the
binary it came from, which for Claude Code means it is not yours to republish.

## ⚙️ Options

| Flag                            | Meaning                                                                                                                                            |
| :------------------------------ | :-------------------------------------------------------------------------------------------------------------------------------------------------- |
| `-o`, `--out <dir>`             | Output directory, default `./out`. A universal binary gets one sub-directory per architecture.                                                     |
| `-l`, `--list`                  | List the packed files and write nothing.                                                                                                           |
| `--path-patching <true\|false>` | Default true. Points packed paths at the extracted files so the output can run. Set it to false to get every file exactly as packed, byte for byte. |
| `--bytecode`                    | Also dump the JSC bytecode cache. It is usually several times the size of the source.                                                              |
| `--json`                        | Print the manifest as JSON on stdout.                                                                                                              |
| `-v`, `--version`               | Version of this tool.                                                                                                                              |
| `-h`, `--help`                  | Usage.                                                                                                                                             |

## 📂 Output

Files keep the paths the packer recorded, so `/$bunfs/root/src/index.js` lands
at `out/src/index.js`. Traversal segments are dropped.

Packed files claim their paths first, so nothing this tool writes of its own
can displace one. A sourcemap or bytecode dump that would land on a packed
file's path takes a numeric suffix instead, and the manifest is skipped
altogether if a packed file is named after it. Only two packed files that
reduce to the same path can push each other, and then the second takes the
suffix.

```text
out/
  src/index.js       one output file per packed file
  __unpack_manifest.json   every file, with offsets and hashes
  _bytecode/         only with --bytecode
    src/index.js.jsc
```

A universal binary gets one directory per architecture (`out/arm64/`,
`out/x86-64/`). `__unpack_manifest.json` describes every file:

```json
{
  "name": "/$bunfs/root/src/index.js",
  "path": "src/index.js",
  "kind": "JS (bun cjs, bytecode-backed)",
  "moduleFormat": "cjs",
  "size": 1929216,
  "offsetInFile": 46859528,
  "sha256": "8f1dded3...",
  "rewrittenReferences": 9,
  "pathPatching": "applied",
  "skippedReferences": 0,
  "bytecode": { "offset": 120, "length": 13221888, "offsetInFile": 6315136 }
}
```

Manifest paths always use forward slashes, so a manifest written on Windows
matches one written anywhere else.

`sha256` is the hash of the file on disk. `sha256Packed` is the hash of the
bytes as they were packed. They differ only for files whose paths were patched,
which `rewrittenReferences` counts. So you can always check the output against
the binary.

`moduleFormat` is `cjs`, `esm`, or null for anything that is not JavaScript.
It decides how a patched path names the module's own directory, as described
under Limitations. The manifest's top-level `entrypoint` is the `path` of the
file the packer starts with, or null if the packed index points outside the
table.

`pathPatching` says why that count is what it is, which a count of zero cannot:

| `pathPatching`   | Meaning                                                                                                     |
| ---------------- | ----------------------------------------------------------------------------------------------------------- |
| `applied`        | The file was patched. `rewrittenReferences` is what it found, which may be zero if there was nothing to find. |
| `not-applicable` | The file holds no JavaScript, or the run had patching turned off. The manifest's `options` tells them apart.  |
| `reverted`       | Patching ran and was undone, because `skippedReferences` paths could not be placed safely. Written as packed. |

The manifest records the `options` it was produced under for the same reason,
since without them a run with `--path-patching false` reads exactly like a
payload holding no JavaScript. A revert is also reported on stderr as it
happens: it leaves a bundle that looks extracted and does not work, which is
not something to find out from a field.

## 💾 Supported containers

The payload is found by its trailer magic. The executable format only matters
for reporting and for walking the slices of a universal binary.

| Format           | Platform                                                |
| :--------------- | :------------------------------------------------------ |
| ELF              | Linux, x86-64 and arm64                                 |
| Mach-O           | macOS, arm64 and x86-64                                 |
| Mach-O universal | macOS, one payload per slice, each extracted separately |
| PE32+            | Windows, x86-64 and arm64                               |

Tests cover all four. ELF, Mach-O and PE were also checked against real
binaries on all three platforms, by comparing the output against the input.

Those binaries came from **Bun 1.4.0**. They all use the same payload shape: a
32-byte offsets struct with 52-byte module table entries. The tool probes for
both instead of assuming them, so a build from another Bun release should keep
working even if the layout changes.

## 🔍 How it works

Bun appends its payload to the end of the executable:

```text
  ...native executable...
  payload blob          bytecode cache, file contents, sourcemaps,
                        NUL-terminated names
  module table          moduleCount * entrySize
  offsets struct        u64 blobSize, u32 tableOffset, u32 tableLength,
                        u32 entryPointId, ...
  "\n---- Bun! ----\n"
  ...native metadata... ELF section headers, Mach-O code signature, ...
```

Two things trip up a simple parser. Native metadata follows the trailer, so the
trailer is not at the end of the file. And Bun's runtime keeps the magic string
in its own code, so a real binary holds several copies. Only the last one marks
the payload.

The tool does not hard-code the size of the offsets struct or the stride of the
module table. It probes for them, and accepts a candidate only if the first
table entry gives a packed path: `/$bunfs/root/...` on Linux and macOS,
`B:/~BUN/root/...` on Windows.

## ⚠️ Limitations

Patching is a text substitution in JavaScript source. It finds string literals
with a packed path and rewrites them one of two ways. A module specifier, the
string after `import` or `from` or the argument of `import()` and `require()`,
becomes a path relative to the file that holds it, which is what a specifier
is resolved against anyway. Any other literal becomes an expression on the
module's own directory: `__dirname` in CommonJS, `import.meta.dirname` in an
ES module. It only does the second when the literal is in expression position,
which it checks by looking at the characters on each side. This is a
heuristic: the tool does not parse the JavaScript.

If one path in a file cannot be placed safely, the whole file is written
exactly as packed. Nothing is half rewritten, so the worst case is a bundle
that behaves as it did before. These cases cannot be patched:

**Paths that are not literals.** A path built at runtime, `"/$bunfs/root/"`
joined with a name from somewhere else, has no complete literal to replace. Nor
does a path stored in JSON or another data file, which is left alone on
purpose: turning a JSON value into an expression would break the file.

**Paths inside native addons.** A `.node` addon is compiled code. If it opens a
packed path of its own, that string is inside the compiled binary, and
rewriting JavaScript does not touch it. Loading the addon still works, because
the `require` that loads it is a JavaScript literal. The same goes for any path
passed to a subprocess.

**Modules of unknown format.** The directory expression depends on whether a
file is CommonJS or an ES module. The packer's marker line says which for every
module it compiled, and `.mjs` and `.cjs` say so by definition. A plain `.js`
file with neither is taken for CommonJS unless an import or export sits within
its first 512 bytes, so an ES module that opens with a long comment is given
`__dirname`, which it does not have.

**Files that were never packed.** A compiler leaves some imports out of the
bundle and expects them from `node_modules` at runtime. Large binaries often
reference `ws`, `undici` or `react` this way, and `bun:ffi` exists only inside
bun. Patching cannot add files that are not there.

**Code that assumes it is one file.** Inside a compiled binary,
`process.execPath` points at the binary. Extracted, it points at the runtime.
So code that re-spawns itself starts the runtime instead of the program.

## 📚 Library

The CLI is a thin layer over three steps, and you can stop after any of them.
Reading parses one image of the executable and returns its files, touching no
disk. Processing marks packed paths for patching. Writing puts the files
somewhere and returns a record of what it did.

```ts
import {
  BinaryReader,
  buildManifest,
  inspectContainer,
  processFile,
  readSlice,
  writeFile,
  writeManifest,
} from 'bun-unpacker';

const outputDir = 'extracted';

using reader = BinaryReader.open('/path/to/binary');
const container = inspectContainer(reader);

for (const slice of container.slices) {
  const payload = readSlice(reader, container, slice);
  const written = payload.files.map((file) =>
    writeFile(reader, processFile(file, { outputDir, patchPaths: true }), {
      outputDir,
      includeBytecode: false,
    }),
  );
  writeManifest(
    buildManifest(payload, written, { patchPaths: true, includeBytecode: false }),
    outputDir,
  );
}
```

There are two levels here, and they are easy to mix up. An executable holds one
or more images, one per architecture, and the API calls them slices. A normal
binary has one image. A universal Mach-O has several, and each one carries its
own payload. `payload.files` are the packed files inside one image: the bundle,
the addons and the assets.

So the outer loop is over slices, and a Linux or Windows binary goes round it
once. Inside it the work is per file, so taking one file out of a binary does
not mean writing all of them.

`processFile` and `writeFile` both take the output directory, and it has to be
the same one. Paths are patched relative to where each file will land, so two
different directories give you files that cannot find each other.

Nothing is read until it is needed. Each file knows its byte range and reads it
on demand. The writer does not hold a whole file either: it copies in chunks
and patches inside each chunk.

Streams are Web Streams rather than `node:stream`, so reading and patching use
the same API the platform gives a browser. Reading the binary and writing the
output are still Node, through `node:fs`.

## Reference

### `BinaryReader.open`

```ts
BinaryReader.open(filePath: string): BinaryReader;
```

Opens the file for random access by descriptor instead of reading it into
memory. That matters when the file is 250 MB and each lookup reads a few bytes.

It implements `Symbol.dispose`, so `using` closes it at the end of the scope.
Otherwise call `close()`. Calling it twice is safe.

### `inspectContainer`

```ts
inspectContainer(reader: BinaryReader): ContainerInfo;
```

Identifies the executable format and lists the images inside it. `format` is
one of `ELF`, `Mach-O`, `Mach-O universal`, `PE` or `raw`. `architecture` comes
from the header. `slices` has one entry per image. Throws `ContainerError` if a
universal header declares slices that do not fit in the file.

### `describeContents`

```ts
describeContents(fileName: string, header: Buffer): string;
```

The readable type of a packed file from its first bytes: `Mach-O arm64`,
`JSON`, `JS (bun cjs, bytecode-backed)`, falling back to the extension. This
fills the `kind` field. It is exported so you can run the same detection on a
buffer of your own.

### `isJavaScript`

```ts
isJavaScript(kind: string, fileName: string): boolean;
```

Whether a file holds JavaScript, and so whether `processFile` will patch it.
It reads the `kind` above rather than working the answer out again from the
name, because a packed name is whatever the build chose: an entry point stored
as `cli` is as much JavaScript as one stored as `cli.js`. The name is still
consulted as a second opinion, since a couple of the kinds that outrank it rest
on a two-byte magic number.

### `describeModuleFormat`

```ts
describeModuleFormat(fileName: string, header: Buffer): ModuleFormat | null;
```

Whether a JavaScript file is CommonJS or an ES module, from its first bytes:
`cjs`, `esm`, or null when nothing settles it. The packer's marker line says
`@bun-cjs` for CommonJS and nothing for an ES module, so it decides outright.
Without a marker, `.mjs` and `.cjs` decide, and failing those a static import
or export in the header means ESM. This fills `moduleFormat`, and it is what
picks the directory expression when a file is patched.

### `readSlice`

```ts
readSlice(reader: BinaryReader, container: ContainerInfo, slice: ImageSlice): Payload;
```

Parses one image and returns its payload: the layout, the module table stride,
the binary metadata for a manifest, and the files. Writes nothing. Throws
`PayloadNotFoundError` when there is no packer trailer, and `PayloadParseError`
when there is a trailer but the structures it points to are not valid.

`layout.entryPointId` is the index of the file the packer starts with, read
from the offsets struct as stored. `payload.files[payload.layout.entryPointId]`
is that file, when the index is within the table.

### `processFile`

```ts
processFile(file: PayloadFile, options: ProcessOptions): PayloadFile;
```

Marks a file for patching and returns it. The substitution happens later, when
the bytes are read, so this call loads nothing. `{ patchPaths: false }` returns
the file untouched, same as not calling it. `outputDir` must match the one the
file is written to.

### `writeFile`

```ts
writeFile(reader: BinaryReader, file: PayloadFile, options: WriteOptions): ExtractedFile;
```

Writes one file below `options.outputDir` and returns a record of it: where it
went, its sha256 on disk and as packed, and how many paths were patched. Copies
in chunks and patches on the way when `processFile` marked it, so the file is
never held whole. `{ includeBytecode: true }` also dumps its JSC bytecode
cache, which is several times the size of the source.

Pass the same reader the payload was read through. The bytes still come from
the binary, not from memory.

### `describeFile`

```ts
describeFile(file: PayloadFile): ExtractedFile;
```

Builds the record of a file that was not written, so you can report on it
without writing it. Same shape as the `writeFile` result, with the hashes and
the destination null.

### `buildManifest`

```ts
buildManifest(payload: Payload, files: ExtractedFile[], options: ManifestOptions): Manifest;
```

Collects records into a manifest, along with the binary and payload they came
from. It takes whatever the caller gathered, so listing and writing give the
same shape. `options` are the ones the records were produced under: they are
not read back off the records because they cannot be, a run with patching off
being indistinguishable from a payload with no JavaScript in it. `entrypoint`
is looked up in the payload rather than in the records, for the same reason.

### `writeManifest`

```ts
writeManifest(manifest: Manifest, outputDir: string): string | null;
```

Writes the manifest next to the files as `__unpack_manifest.json` and returns
the path. Returns null instead, writing nothing, when a packed file already
landed on that name: what the binary held is never written over.

### `PayloadFile`

What `readSlice` returns, one per packed file. `name` is the path the packer
stored, `/$bunfs/root/src/index.js`. `path` is where it lands relative to an
output directory, collisions already resolved. `size` and `kind` are the byte
count and the readable type, and `moduleFormat` is `cjs`, `esm` or null, as
`describeModuleFormat` answers for JavaScript. `offsetInFile` and `rawEntryHex`
are for looking at the binary itself: where the file sits in it, and the raw
bytes of its module table entry.

Contents come from two methods, and the size decides which one you want.
`bytes()` reads the file into a `Buffer`, which is fine most of the time.
`stream()` returns a `ReadableStream<Uint8Array>` for the ones you would rather
not hold at once: the bytecode cache of a real binary runs to 150 MB. It takes
an optional region, so `file.stream(file.bytecode)` reads that cache instead of
the source. `sourcemap` and `bytecode` are those regions, or null when the file
has none.

```ts
import { createHash } from 'node:crypto';

for (const file of readSlice(reader, container, slice).files) {
  const digest = createHash('sha256').update(file.bytes()).digest('hex');
  console.log(file.path, file.size, file.kind, digest);
}
```

The stream pulls, so nothing is read until the consumer asks for it. It reads
through the payload's reader, so keep that reader open until the stream is
done.

`node:stream/consumers` turns a stream back into a value:

```ts
import { buffer, text } from 'node:stream/consumers';

const source = await text(file.stream());
const cache = await buffer(file.stream(file.bytecode));
```

Doing that on the file itself is the same as `bytes()`, only slower. Use it for
a region other than the file, or when the stream passes through a transform.

### `createRewriteStream`

```ts
createRewriteStream(fileDirectory: string, outputRoot: string, format?: ModuleFormat): RewriteStream;
```

Path patching as a `TransformStream`, for callers assembling their own pipe
rather than going through `writeFile`:

```ts
const patch = createRewriteStream(fileDirectory, outputRoot, file.moduleFormat ?? 'cjs');
await file.stream().pipeThrough(patch.stream).pipeTo(destination);
console.log(patch.counts()); // { rewritten, skipped }
```

`format` picks the directory expression, `__dirname` or `import.meta.dirname`,
and defaults to `cjs`. It has to be given: a file's references cannot say what
it is, since an ES module whose references are all in expression position
holds no specifier to give it away.

The transform holds no opinion about chunk size, keeping a tail of its own, so
a source handing over a few kilobytes at a time patches the same as one handing
over megabytes. `counts()` is meaningful once the stream has finished.

Note that `writeFile` applies the all-or-nothing rule and this does not. A
`skipped` above zero means the output has a mix of patched and packed paths,
and it is the caller's job to fall back to the packed bytes.

### Names and version

```ts
MANIFEST_FILE_NAME: string; // '__unpack_manifest.json'
BYTECODE_DIRECTORY: string; // '_bytecode'
TOOL_VERSION: string;
```

The names this package writes, so a caller can look for the manifest or skip
the bytecode directory without hard-coding either, and the version it reports
in a manifest.

### `toRelativePath`

```ts
toRelativePath(name: string): string;
```

Turns a packed path into where the file lands, dropping traversal segments.
This is the function behind a file's `path`.

## 📄 Scope and licensing

This tool is MIT licensed and contains no third-party code.

What comes out of a binary is not. It stays under that binary's own license,
and this tool neither bundles nor redistributes any of it. It is for unpacking
a copy you already have, for research or debugging.

## 🛠️ Development

`src/core` is the extractor: containers, the payload format, reading a slice,
patching and writing files out. `src/cli` is the command line program built on
it, with its flags and its output formatting. Only the first is the library.
Nothing in `src/cli` is exported.

Requires Node 22 or newer.

```sh
npm install
npm run build         # tsc, output in dist/
npm test              # compiles src and test, then runs node:test
npm run test:smoke    # runs dist/cli.js against a synthetic binary
npm run lint          # eslint with type-checked rules
npm run format:check  # prettier
```

Tests build synthetic Bun executables byte for byte: payload blob, module
table, offsets struct, trailer, and a universal wrapper around all of it. That
covers struct sizes and table strides beyond the ones current releases emit.

Test output goes to `.tmp/` inside the repository, which is gitignored.

## License

MIT
