# bun-unpacker

[![CI](https://github.com/Enuvid/bun-unpacker/actions/workflows/ci.yml/badge.svg)](https://github.com/Enuvid/bun-unpacker/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/bun-unpacker)](https://www.npmjs.com/package/bun-unpacker)

📦 Extract the files packed into a `bun build --compile` executable: the
JavaScript bundle, native addons, sourcemaps and assets. This is unpacking
rather than decompiling a Bun binary: the files are embedded whole, so they are
copied out byte for byte rather than reconstructed from machine code.

## 🚀 Quick start

See what is inside:

```console
$ npx bun-unpacker ./my-app --list

my-app  58.4 MB  (/home/you/build/my-app)
ELF · x86-64 · payload 41.2 MB at 0x2c41008 · 3 files · 52-byte entries

  path             size  kind                           bytecode
  -----------  --------  -----------------------------  --------
  index.js      1.84 MB  JS (bun cjs, bytecode-backed)   12.6 MB
  sharp.node    1.40 MB  ELF x86-64                      -
  schema.json   9.11 KB  JSON                            -

  total extracted: 3.25 MB
```

Extract:

```sh
npx bun-unpacker ./my-app            # extract to ./out
npx bun-unpacker ./my-app -o dump    # explicit target
```

Run unpacked JS:

```sh
bun ./out/index.js --version
```

Paths inside JS files are patched during extraction, so the assets can load.
Pass `--path-patching false` to get every file exactly as packed.

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
at `out/src/index.js`. Traversal segments are dropped. Two files that would
land on the same path get a numeric suffix instead of overwriting each other.

```text
out/
  src/index.js       one output file per packed file
  manifest.json      every file, with offsets and hashes
  _bytecode/         only with --bytecode
    src/index.js.jsc
```

A universal binary gets one directory per architecture (`out/arm64/`,
`out/x86-64/`). `manifest.json` describes every file:

```json
{
  "name": "/$bunfs/root/src/index.js",
  "path": "src/index.js",
  "kind": "JS (bun cjs, bytecode-backed)",
  "size": 1929216,
  "offsetInFile": 46859528,
  "sha256": "8f1dded3...",
  "bytecode": { "offset": 120, "length": 13221888, "offsetInFile": 6315136 }
}
```

Manifest paths always use forward slashes, so a manifest written on Windows
matches one written anywhere else.

`sha256` is the hash of the file on disk. `sha256Packed` is the hash of the
bytes as they were packed. They differ only for files whose paths were patched,
which `rewrittenReferences` counts. So you can always check the output against
the binary.

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
  offsets struct        u64 blobSize, u32 tableOffset, u32 tableLength, ...
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
от
Patching is a text substitution in JavaScript source. It finds string literals
with a packed path and turns them into `__dirname` expressions. It only does
this when the literal is in expression position, which it checks by looking at
the characters on each side. This is a heuristic: the tool does not parse the
JavaScript.

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
  writeManifest(buildManifest(payload, written), outputDir);
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

### `readSlice`

```ts
readSlice(reader: BinaryReader, container: ContainerInfo, slice: ImageSlice): Payload;
```

Parses one image and returns its payload: the layout, the module table stride,
the binary metadata for a manifest, and the files. Writes nothing. Throws
`PayloadNotFoundError` when there is no packer trailer, and `PayloadParseError`
when there is a trailer but the structures it points to are not valid.

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
buildManifest(payload: Payload, files: ExtractedFile[]): Manifest;
```

Collects records into a manifest, along with the binary and payload they came
from. It takes whatever the caller gathered, so listing and writing give the
same shape.

### `writeManifest`

```ts
writeManifest(manifest: Manifest, outputDir: string): string;
```

Writes the manifest next to the files as `manifest.json` and returns the path.

### `PayloadFile`

What `readSlice` returns, one per packed file. `name` is the path the packer
stored, `/$bunfs/root/src/index.js`. `path` is where it lands relative to an
output directory, collisions already resolved. `size` and `kind` are the byte
count and the readable type. `offsetInFile` and `rawEntryHex` are for looking
at the binary itself: where the file sits in it, and the raw bytes of its
module table entry.

Contents come from two methods, and the size decides which one you want.
`bytes()` reads the file into a `Buffer`, which is fine most of the time.
`stream()` returns a `Readable` for the ones you would rather not hold at once:
the bytecode cache of a real binary runs to 150 MB. It takes an optional
region, so `file.stream(file.bytecode)` reads that cache instead of the source.
`sourcemap` and `bytecode` are those regions, or null when the file has none.

```ts
import { createHash } from 'node:crypto';

for (const file of readSlice(reader, container, slice).files) {
  const digest = createHash('sha256').update(file.bytes()).digest('hex');
  console.log(file.path, file.size, file.kind, digest);
}
```

`node:stream/consumers` turns a stream back into a value:

```ts
import { buffer, text } from 'node:stream/consumers';

const source = await text(file.stream());
const cache = await buffer(file.stream(file.bytecode));
```

Doing that on the file itself is the same as `bytes()`, only slower. Use it for
a region other than the file, or when the stream passes through a transform.

### `toRelativePath`

```ts
toRelativePath(name: string): string;
```

Turns a packed path into where the file lands, dropping traversal segments.
This is the function behind a file's `path`.

### `unpackBinary` and `unpackTargets`

```ts
unpackBinary(filePath: string, options: UnpackOptions, streams: Streams): BinaryResult;
unpackTargets(targets: string[], options: UnpackOptions, streams: Streams): number;
```

The whole pipeline with the reporting this CLI prints: one executable and all
its slices, or several targets with one directory each and a combined JSON
report. `unpackTargets` returns the process exit code.

The pieces this CLI is built from are exported too: argument parsing with its
checks, the reporting, the exit codes and the stream handles. So a wrapper can
add its own way of finding binaries without rebuilding the rest.

## 📄 Scope and licensing

This tool is MIT licensed and contains no third-party code.

What comes out of a binary is not. It stays under that binary's own license,
and this tool neither bundles nor redistributes any of it. It is for unpacking
a copy you already have, for research or debugging.

## 🛠️ Development

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
