# bun-unpacker

[![CI](https://github.com/Enuvid/bun-unpacker/actions/workflows/ci.yml/badge.svg)](https://github.com/Enuvid/bun-unpacker/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/bun-unpacker)](https://www.npmjs.com/package/bun-unpacker)

Reads an executable built with `bun build --compile` and writes out the files
packed inside it: the JavaScript bundle, native addons, sourcemaps and any
other embedded asset.

The package contains source code only. It ships no third-party code and no
extracted artifacts, and it downloads nothing: you point it at a binary that is
already on your machine, and it copies the contents out byte for byte. Nothing
is executed, decompiled or deobfuscated; files come out exactly as the packer
stored them.

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

## Options

| Flag                | Meaning                                                                                        |
| :------------------ | :--------------------------------------------------------------------------------------------- |
| `-o`, `--out <dir>` | Output directory, default `./out`. A universal binary gets one sub-directory per architecture. |
| `-l`, `--list`      | Print the module table and write nothing.                                                      |
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
against real binaries produced by Bun 1.4.0, on all three platforms, by
comparing extracted bytes against the input.

## Library

```ts
import { BinaryReader, inspectContainer, extractSlice } from 'bun-unpacker';

using reader = BinaryReader.open('/path/to/binary');
const container = inspectContainer(reader);

for (const slice of container.slices) {
  const manifest = extractSlice(reader, container, slice, {
    outputDir: 'extracted',
    write: true,
    includeBytecode: false,
  });
  console.log(manifest.modules.map((module) => module.path));
}
```

`unpackBinary` and `unpackTargets` are exported as well, for tools that wrap
this CLI with their own way of finding binaries.
[claude-code-unpacker](https://github.com/Enuvid/claude-code-unpacker) is one
such wrapper.

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
