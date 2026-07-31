# bun-unpacker

[![CI](https://github.com/Enuvid/bun-unpacker/actions/workflows/ci.yml/badge.svg)](https://github.com/Enuvid/bun-unpacker/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/bun-unpacker)](https://www.npmjs.com/package/bun-unpacker)

Reads an executable built with `bun build --compile` and writes out the files
packed inside it: the JavaScript bundle, native addons, sourcemaps and any
other embedded asset.

The package contains source code only. It ships no third-party code and no
extracted artifacts, and it downloads nothing: you point it at a binary that is
already on your machine. Nothing is executed, decompiled or deobfuscated.

A packed bundle refers to its assets and native addons by absolute paths into
the packer's virtual filesystem, such as `/$bunfs/root/mermaid.min.js` on Linux
and macOS or `B:/~BUN/root/mermaid.min.js` on Windows. That filesystem is
served by the runtime inside the compiled binary and exists nowhere else, so
extracted files carrying those references look for their assets at a path that
is not there.

By default those references are patched to point at the extracted files, which
is what makes the output runnable rather than inert. Pass
`--path-patching false` to get every file exactly as packed.


## Quick start

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

Drop `--list` to write the files to `./out`:

```sh
npx bun-unpacker ./my-app           # extract to ./out
bunx bun-unpacker ./my-app -o dump  # explicit target
```

What comes out runs, because the packed references were patched to point at the
extracted files:

```sh
bun ./out/index.js --version
```

Under bun rather than node: a packed bundle is wrapped in a function the Bun
runtime knows to call, and it may reach for Bun's own built-ins. Running it
with node evaluates the wrapper and exits without executing a line.


## Options

| Flag                | Meaning                                                                                        |
| :------------------ | :--------------------------------------------------------------------------------------------- |
| `-o`, `--out <dir>` | Output directory, default `./out`. A universal binary gets one sub-directory per architecture. |
| `-l`, `--list`      | Print the module table and write nothing.                                                      |
| `--path-patching <true\|false>` | Default true. Points the packed references at the extracted files so the output can run. Set it to false to write every file exactly as packed, byte for byte, which is the mode for verifying against the binary or diffing one build against another. |
| `--bytecode`        | Also dump the JSC bytecode cache. It is typically several times the size of the source.        |
| `--json`            | Print the manifest as JSON on stdout.                                                          |
| `-v`, `--version`   | Version of this tool.                                                                          |
| `-h`, `--help`      | Usage.                                                                                         |


## Output

Extracted files keep the paths the packer recorded, so `/$bunfs/root/src/index.js`
lands at `out/src/index.js`. Traversal segments are dropped, and two modules
that would land on the same path get a numeric suffix rather than overwriting
each other.

```text
out/
  src/index.js       one file per embedded module
  manifest.json      every module, with offsets and hashes
  _bytecode/         only with --bytecode
    src/index.js.jsc
```

A universal binary gets one directory per architecture (`out/arm64/`,
`out/x86-64/`). `manifest.json` describes every module:

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
compares equal to one written anywhere else.

`sha256` is the hash of the file on disk and `sha256Packed` the hash of the
bytes as they were packed. They differ exactly for the files whose references
were rewritten, which `rewrittenReferences` counts, so the packed bytes stay
verifiable against the binary either way.


## Supported containers

The payload is found by its trailer magic, so the executable format only
matters for reporting and for walking the slices of a universal binary.

| Format           | Platform                                                |
| :--------------- | :------------------------------------------------------ |
| ELF              | Linux, x86-64 and arm64                                 |
| Mach-O           | macOS, arm64 and x86-64                                 |
| Mach-O universal | macOS, one payload per slice, each extracted separately |
| PE32+            | Windows, x86-64 and arm64                               |


All four are covered by tests. ELF, Mach-O and PE were additionally verified
against real binaries, on all three platforms, by comparing extracted bytes
against the input.

Those binaries were produced by **Bun 1.4.0**, and all of them use the same
payload shape: a 32-byte offsets struct with 52-byte module table entries. Both
are probed rather than assumed, so a build from another Bun release should work
even if it reshapes them, and the synthetic executables the tests build cover
sizes and strides no current release emits.


## How it works

Bun appends its payload to the end of the executable image:

```text
  ...native executable...
  payload blob          bytecode cache, file contents, sourcemaps,
                        NUL-terminated names
  module table          moduleCount * entrySize
  offsets struct        u64 blobSize, u32 tableOffset, u32 tableLength, ...
  "\n---- Bun! ----\n"
  ...native metadata... ELF section headers, Mach-O code signature, ...
```

Two details make a naive reader fail. Native metadata follows the trailer, so
it does not sit at the end of the file. And Bun's own runtime carries the magic
as a string literal, so a real binary contains several copies and only the last
one marks the payload.

The size of the offsets struct and the stride of the module table are probed
instead of hard-coded. A candidate is accepted only if the first table entry
resolves to a packer path: `/$bunfs/root/...` on Linux and macOS,
`B:/~BUN/root/...` on Windows. That keeps the parser working across Bun
releases that reshape those structures.


## Limitations

Patching is a textual substitution over JavaScript source. It finds string
literals holding a packer path and turns them into `__dirname` expressions, and
it only does so where the literal sits in expression position, which is decided
by looking at the characters either side of it. That is a heuristic, not a
parse. A file holding even one reference it cannot place safely is left exactly
as packed rather than half rewritten, so the failure mode is a bundle that
behaves as it did before rather than one that is subtly broken. Still, the
following are outside what it can reach.

**Paths that are not literals.** A path assembled at runtime, `"/$bunfs/root/"`
concatenated with a name from elsewhere, is invisible: there is no complete
literal to replace. So is one stored in JSON or any other data file, which is
left alone deliberately, since turning a JSON value into an expression would
produce a file that no longer parses.

**Paths inside native addons.** A `.node` module is compiled code. If it opens
a packer path of its own, that string lives in the compiled binary and no
amount of rewriting JavaScript will change it. Loading the addon works, because
the `require` that loads it is a JavaScript literal and gets patched, but what
the addon does with paths afterwards is beyond reach. The same applies to any
path handed to a subprocess.

**Things the extracted bundle needs that were never packed.** A compiler leaves
some imports unbundled, expecting them from `node_modules` at runtime. The
Claude Code binary references `ws`, `undici`, `react` and a handful of others
that way, and `bun:ffi`, which exists only inside bun. Patching cannot supply
what was not there.

**Anything that assumed it was one file.** `process.execPath` inside a compiled
binary points at the binary itself; extracted, it points at whatever runtime is
running the bundle, so code that re-spawns itself does something different.

The output directory can be moved as a whole, since the rewritten paths are
relative to each file, but moving files around inside it breaks them. Passing
`--path-patching false` avoids all of this by changing nothing, at the cost of
an extraction that cannot run.


## Library

The CLI is a thin layer over three steps, and you can stop after any of them.
Reading parses one image of the executable and hands back its modules without
touching the disk. Processing rewrites the packed references. Writing puts the
files somewhere and returns a record of what it did.

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

```

Two levels are in play, and it is worth keeping them apart. `container.slices`
are the images inside the executable, one per architecture: an ordinary binary
has a single one, a universal Mach-O has several, each carrying a payload of
its own. `payload.files` are the packed files inside one image, which is where
the bundle, the addons and the assets are.

The loop above is over the first. Getting every file out of one image is not a
loop at all: `writeSliceFs` takes the payload and writes all of its files in one
call. So a Linux or Windows binary goes round once, and only a universal
Mach-O goes round more than that.

Both `processSlice` and `writeSliceFs` take the output directory and it has to
be the same one. References are rewritten relative to where each file will
land, so two different directories give you files that cannot find each other.

Nothing is read eagerly. A module knows its byte range and fetches it when
asked, and the writer never holds a file either: it copies in chunks and, when
patching, substitutes as those chunks go past.


## Reference


### `BinaryReader.open`

```ts
BinaryReader.open(filePath: string): BinaryReader;
```

Random access over the file by descriptor rather than reading it into memory,
which matters when the file is a quarter of a gigabyte and every lookup touches
a handful of bytes. Disposable, so `using` closes it at the end of the scope,
and `close()` is idempotent for the times it cannot be.


### `inspectContainer`

```ts
inspectContainer(reader: BinaryReader): ContainerInfo;
```

Identifies the executable format and lists the images inside it. `format` is
one of `ELF`, `Mach-O`, `Mach-O universal`, `PE` or `raw`, `architecture` reads
from the header, and `slices` has one entry per image. Throws `ContainerError`
for a universal header declaring slices that do not fit inside the file.


### `describeContents`

```ts
describeContents(fileName: string, header: Buffer): string;
```

The readable type of an embedded file from its first bytes, `Mach-O arm64` or
`JSON` or `JS (bun cjs, bytecode-backed)`, falling back to the extension. Used
for the `kind` of every file, and exported for running the same guess on a
buffer of your own.


### `readSlice`

```ts
readSlice(reader: BinaryReader, container: ContainerInfo, slice: ImageSlice): Payload;
```

Parses one image and returns its payload: the layout it found, the module table
stride, the binary metadata that goes into a manifest, and the modules. Writes
nothing. Throws `PayloadNotFoundError` when there is no packer trailer and
`PayloadParseError` when the structures behind one make no sense.


### `processFile`

```ts
processFile(file: PayloadFile, options: ProcessOptions): PayloadFile;
```

Marks one file whose packed references are to be rewritten and returns it; the
substitution itself happens when the bytes are read, so nothing is loaded here.
`{ patchPaths: false }` returns the file untouched, which is the same as not
calling it. `outputDir` must match the one the file is written to.


### `writeFile`

```ts
writeFile(reader: BinaryReader, file: PayloadFile, options: WriteOptions): ExtractedFile;
```

Writes one file below `options.outputDir` and returns the record of it: where
it went, its sha256 on disk and as packed, and how many references were
rewritten. Copies in chunks, substituting on the way when `processFile` marked
it, so the file is never held whole. `{ includeBytecode: true }` also dumps its
JSC bytecode cache, which is several times the size of the source.

The reader is the one the payload was read through, since the bytes still come
from the binary rather than from memory.


### `describeFile`

```ts
describeFile(file: PayloadFile): ExtractedFile;
```

The record of a file that was not written, for reporting without writing. Same
shape as what `writeFile` returns, with the hashes and the destination null.


### `buildManifest`

```ts
buildManifest(payload: Payload, files: ExtractedFile[]): Manifest;
```

Gathers records into a manifest, carrying the binary and payload they came
from. Takes whatever the caller collected, so listing and writing produce the
same shape.


### `PayloadFile`

What `readSlice` hands back, one per packed file.
`name` is the path the packer stored, `/$bunfs/root/src/index.js`. `path` is
where it lands relative to an output directory, with collisions already
resolved. `size` and `kind` are the byte count and the readable type.
`offsetInFile` and `rawEntryHex` are for looking at the binary itself: where
the module sits in it, and the raw bytes of its module table entry.

Contents come from two methods, and which one you want depends on the size.
`bytes()` reads the whole file into a `Buffer` and hands it back, which is what
you want most of the time. `stream()` returns a `Readable` instead, for the
ones you would rather not hold at once: the bytecode cache of a real binary
runs to 150 MB. It takes an optional region, so `file.stream(file.bytecode)`
reads that cache rather than the source, and `sourcemap` and `bytecode` are
those regions, or null when the file has none.

```ts
import { createHash } from 'node:crypto';

for (const file of readSlice(reader, container, slice).files) {
  const digest = createHash('sha256').update(file.bytes()).digest('hex');
  console.log(file.path, file.size, file.kind, digest);
}
```

A stream is not always what you want in the end. `node:stream/consumers` turns
one back into a value once it has been read:

```ts
import { buffer, text } from 'node:stream/consumers';

const source = await text(file.stream());
const cache = await buffer(file.stream(file.bytecode));
```

Doing that on the file itself is the same as calling `bytes()`, only slower,
so reach for it when the region is something other than the file, or when the
stream has been through a transform on the way.


### `writeManifest`

```ts
writeManifest(manifest: Manifest, outputDir: string): string;
```

Writes the manifest beside the files as `manifest.json` and returns the path.


### `toRelativePath`

```ts
toRelativePath(name: string): string;
```

The packer path of a module reduced to where it lands, traversal segments
dropped. This is the function behind a file's `path`.


### `unpackBinary` and `unpackTargets`

```ts
unpackBinary(filePath: string, options: UnpackOptions, streams: Streams): BinaryResult;
unpackTargets(targets: string[], options: UnpackOptions, streams: Streams): number;
```

The whole pipeline with the reporting this CLI prints: one executable and every
slice of it, or several with a directory per target and the JSON aggregation.
`unpackTargets` returns the process exit code. Between them and the pieces
listed under [building another CLI](#building-another-cli-on-top) a wrapper can
add its own way of finding binaries without reimplementing the rest.


The pieces this CLI is built from are exported as well, argument parsing with
its validations, the reporting, the exit codes and the stream handles, so a
wrapper can add its own way of finding binaries without reimplementing the rest
or drifting from it.


## Scope and licensing

This tool is MIT licensed and contains no third-party code.

What it extracts is a different matter. Whatever comes out of a binary stays
under that binary's own licence, and the tool neither bundles nor redistributes
any of it. Unpacking a copy you already have, for research or debugging, is
what this is for.


## Development

Requires Node 22 or newer.

```sh
npm install
npm run build         # tsc, output in dist/
npm test              # compiles src and test, then runs node:test
npm run test:smoke    # runs dist/cli.js against a synthetic binary
npm run lint          # eslint with type-checked rules
npm run format:check  # prettier
```

The test suite builds synthetic Bun executables byte for byte: payload blob,
module table, offsets struct, trailer, and a universal wrapper around the lot.
That covers struct sizes and table strides other than the ones current releases
use, which no real binary would exercise.


## Licence

MIT
