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
ELF · x86-64 · payload 41.2 MB at 0x2c41008 · 3 modules · 52-byte entries

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


## Library

The CLI is a thin layer over three steps, and you can stop after any of them.

```ts
import {
  BinaryReader,
  inspectContainer,
  processSlice,
  readSlice,
  writeManifest,
  writeSliceFs,
} from 'bun-unpacker';

const outputDir = 'extracted';

using reader = BinaryReader.open('/path/to/binary');
const container = inspectContainer(reader);

for (const slice of container.slices) {
  const payload = processSlice(readSlice(reader, container, slice), {
    outputDir,
    patchPaths: true,
  });
  const manifest = writeSliceFs(payload, { outputDir, includeBytecode: false });
  writeManifest(manifest, outputDir);
}
```


### Opening a binary

`BinaryReader.open(path)` gives random access over the file by descriptor
rather than reading it into memory, which matters when the file is a quarter of
a gigabyte and every lookup touches a handful of bytes. It is disposable, so
`using` closes it at the end of the scope.

`inspectContainer(reader)` identifies the executable format and lists the
images inside it. Ordinary binaries hold one. A universal Mach-O holds one per
architecture, each with its own payload, which is why the example loops rather
than taking the first.


### Reading a slice

`readSlice(reader, container, slice)` parses one image and returns its payload.
Nothing is written, and nothing is read eagerly: each module knows its byte
range and fetches it when asked.

A module says where it came from and where it would go. `name` is the path the
packer stored, `/$bunfs/root/src/index.js`. `path` is where it lands relative
to an output directory, with collisions already resolved. `size` and `kind` are
the byte count and a readable type such as `Mach-O arm64`, the latter sniffed
from the first bytes by `describeContents`, which is exported separately for
running the same guess on a buffer of your own.

Contents come from two methods, and which one you want depends on the size.
`bytes()` reads the whole file into a `Buffer` and hands it back, which is what
you want most of the time. `stream()` returns a `Readable` instead, for the
ones you would rather not hold at once: the bytecode cache of a real binary
runs to 150 MB. It takes an optional region, so `module.stream(module.bytecode)`
reads that cache rather than the source, and `sourcemap` and `bytecode` are
those regions, or null when the module has none.

A stream is not always what you want in the end. `node:stream/consumers` turns
one back into a value once it has been read:

```ts
import { buffer, text } from 'node:stream/consumers';

const source = await text(module.stream());
const cache = await buffer(module.stream(module.bytecode));
```

Doing that on the module itself is the same as calling `bytes()`, only slower,
so reach for it when the region is something other than the file, or when the
stream has been through a transform on the way.

```ts
import { createHash } from 'node:crypto';

for (const module of readSlice(reader, container, slice).modules) {
  const digest = createHash('sha256').update(module.bytes()).digest('hex');
  console.log(module.path, module.size, module.kind, digest);
}
```

`offsetInFile` and `rawEntryHex` are there for looking at the binary itself:
where the module sits in it, and the raw bytes of its module table entry.
`toRelativePath(name)` is the function behind `path`, exported for anyone
reducing a packer path on their own.


### Patching and writing

`processSlice(payload, { outputDir, patchPaths })` rewrites the packed
references so the extracted files can find each other, and returns a payload
carrying the patched contents. With `patchPaths: false` it returns the payload
untouched, which is the same as not calling it.

`writeSliceFs(payload, { outputDir, includeBytecode })` writes the files and
returns the manifest describing what it wrote. `writeManifest(manifest, dir)`
puts that manifest beside them as `manifest.json`.

Both steps take the output directory and it has to be the same one. References
are rewritten relative to where each file will land, so two different
directories give you files that cannot find each other.


### When something is wrong

`PayloadNotFoundError` means no packer trailer, so the file was not built with
`bun build --compile`. `PayloadParseError` means there is a trailer but the
structures behind it make no sense, and it carries the candidate sizes and
strides that were tried. `ContainerError` means a universal header declaring
slices that do not fit inside the file.


### Building another CLI on top

`unpackBinary(path, options, streams)` runs the pipeline over one executable,
every slice of it, printing as it goes. `unpackTargets(paths, options, streams)`
does the same for several, with a directory per target and the JSON
aggregation, and returns the process exit code.

The pieces they are built from are exported too, so a wrapper that adds its own
way of finding binaries does not reimplement the rest or drift from it:
`parseArguments` for the shared flags, `requireOutputDir`, `requireBoolean` and
`requireAtMostOneBinary` for validating its own the same way, `asUsageError`
and `UsageError` for turning a parser complaint into exit code 2, `reportSlice`
with `formatBytes` and `renderTable` for identical output, `consoleStreams` and
`describeError` for the printing, and `EXIT_OK`, `EXIT_FAILURE` and
`EXIT_USAGE` for the codes. `DEFAULT_OUTPUT_DIR`, `MANIFEST_FILE_NAME`,
`BYTECODE_DIRECTORY` and `TOOL_VERSION` are the names this CLI uses.


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
