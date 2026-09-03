# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).


## [Unreleased]


## [0.12.1]


### Fixed

- The quick start in the README still showed the previous generation of
  Claude Code, with the entry point at `src/entrypoints/cli.js`, and ran it by
  that name. It now shows the chunked 2.1.259 bundle and runs whichever file
  the manifest records as `entrypoint`. The package page on npm renders the
  README that was published, which is what this release is for.


## [0.12.0]


### Fixed

- An ES module had every reference left as packed. The bundle names the chunks
  it imports in `import` and `export` statements, where the grammar allows a
  string literal and nothing else, so the substitution that turns a literal
  into an expression had nowhere to go, counted each one as skipped, and the
  all-or-nothing rule reverted the file. Claude Code 2.1.259 packs 1835 files,
  1649 of them chunks importing one another this way, and the extracted bundle
  failed on its first import with some fifteen hundred warnings above it. A
  module specifier is now rewritten to a path relative to the file that holds
  it, which is what a specifier is resolved against anyway. The arguments of
  `import()` and `require()` go the same way.
- A path in expression position in an ES module was rewritten in terms of
  `__dirname`, which an ES module does not have. Bun leaves it undefined
  there, as Node does, so the three chunks 0.11.0 did patch in that same
  binary failed with a ReferenceError at runtime. An ES module now gets
  `import.meta.dirname`. CommonJS keeps `__dirname`, since `import.meta` is a
  syntax error there.


### Added

- `moduleFormat` on each file, in the payload and in the manifest: `cjs`,
  `esm`, or null. It is read from the packer's marker line, failing that from
  a `.mjs` or `.cjs` extension, failing that from an import or export near the
  top of the file. It is what chose the directory expression. A file it cannot
  place is patched as CommonJS, which is how every file used to be patched.
- `describeModuleFormat`, the rule above, beside `describeContents`.
- `entrypoint` in the manifest, and `entryPointId` in its payload layout: the
  file the packer starts with, which the offsets struct has recorded all
  along. It is not `files[0]`: Claude Code 2.1.259 keeps its entry point
  sixth, and anything reading the manifest had to guess it from the names.
  The report prints it as `entry point`.
- `createRewriteStream` takes the module format as a third argument, so a
  caller assembling its own pipe gets the same directory expression as
  `writeFile`. It defaults to CommonJS, which is what it always produced.


### Changed

- `rewrittenReferences` counts specifiers rewritten to relative literals along
  with literals rewritten to expressions.


## [0.11.0]


### Fixed

- A packed file was patched or left alone according to its extension, while the
  kind reported for it had already been read from its contents. Packed names
  are whatever the build chose, so a bundle whose entry point is stored as
  `cli` rather than `cli.js` had every virtual filesystem reference left as
  packed, and the extracted bundle failed on first asset use with nothing in
  the output to say why. Claude Code 2.1.241 renamed exactly that way, which
  cost its main module all nine of its references. Content and name now settle
  it together, and the kind is what leads.


### Added

- `pathPatching` and `skippedReferences` in each manifest file record. A
  `rewrittenReferences` of zero used to stand for three different things: a
  file with nothing to patch, a file patching does not apply to, and a file
  whose patch was reverted because one path could not be placed safely. Telling
  them apart meant extracting a second time and running the substitution by
  hand.
- `options` in the manifest, so a manifest says what it was produced under.
  Without it every file in a `--path-patching false` run reads exactly like a
  payload holding no JavaScript.
- A warning on stderr when the all-or-nothing rule writes a file exactly as
  packed. That case leaves a bundle that looks extracted and does not work, and
  it used to pass in silence.
- `isJavaScript`, the rule deciding which files are eligible for path
  patching, beside the `describeContents` whose answer it reads.


### Changed

- `buildManifest` takes the options the records were produced under as a third
  argument.


## [0.10.1]


### Fixed

- A stray word had been left on its own line under Limitations in the README.


## [0.10.0]


### Fixed

- A packed file could be renamed to make room for something this tool writes
  itself. A binary packing its own `manifest.json`, or a `.map` beside a file
  that also carries a sourcemap, had the packed one moved aside. Packed files
  now claim their paths first and the sidecars are what move.
- A reference was translated by one rule and the file placed by another, so a
  packed name holding `..` landed in one place while the patched reference
  pointed at another file entirely. Both go through the same function now.


### Changed

- The manifest is `__unpack_manifest.json` rather than `manifest.json`, which a
  binary is far less likely to pack. If one does pack that name, the packed
  file wins and `writeManifest` returns null without writing: what the binary
  held is never written over.


## [0.9.1]


### Fixed

- Quick start extracted to one directory and then ran from another, so the
  example did not work as written.


## [0.9.0]


### Removed

- Nothing from `src/cli` is exported any more: `unpackBinary`, `unpackTargets`,
  the exit codes, `consoleStreams`, `describeError`, `UsageError`,
  `asUsageError`, the flag validators, `DEFAULT_OUTPUT_DIR`, and the
  `Streams`, `UnpackOptions` and `BinaryResult` types. They existed for a
  wrapper package that no longer exists. The library is the extractor, and the
  command line program is a program.


### Changed

- Quick start walks through Claude Code, which is where this started and the
  executable most people arrive with.
- The package description is back to describing the tool rather than naming one
  of its targets.




## [0.8.2]


### Changed

- `claude-code` is out of the keywords. Prose covers it where it belongs.


## [0.8.1]


### Changed

- The readme walks through unpacking Claude Code, which is the executable most
  people arrive with, and the package description says so too.


## [0.8.0]


### Removed

- `formatBytes`, `renderTable`, `parseArguments`, `CliOptions` and
  `reportSlice` are no longer exported. They are how this CLI renders and reads
  its own flags, not something a caller reaches for, and a wrapper brings its
  own. Everything a wrapper does use is still exported.


### Changed

- Source is split into `src/core`, the extractor, and `src/cli`, the command
  line program built on it. Tests follow the same split. Nothing moved in the
  published entry points: `bun-unpacker` and `dist/cli.js` are where they were.


## [0.7.1]


### Changed

- The reader uses TypeScript access modifiers rather than hash-private fields,
  which were the only ones in the codebase. No effect on what the package does.


## [0.7.0]


### Changed

- `PayloadFile.stream()` returns a `ReadableStream<Uint8Array>` rather than a
  `node:stream` `Readable`. Both platforms have Web Streams, so the reading and
  patching side of the library no longer depends on Node for its stream type.
  Code that pipes or iterates a stream keeps working; code that used a
  `Readable` method such as `pipe()` needs `pipeTo()` instead.
- A stream reads through the payload's reader rather than opening the file
  again, so it now needs that reader open until it finishes. This is what
  `bytes()` always did.


### Added

- `createRewriteStream`, path patching as a `TransformStream`, so a caller can
  patch inside a pipe instead of going through `writeFile`.


## [0.6.0]


### Fixed

- A chunk boundary could fall inside a reference that had already been scanned,
  when two references sat within a few characters of each other. Neither half
  matched afterwards, so the reference stayed packed without counting as
  skipped, and the all-or-nothing rule never fired: the file reached disk with
  a mix of patched and packed paths. The boundary now steps back past every
  match it would cut.
- Sourcemap and bytecode sidecars are named through the same table as the files
  themselves, so a packed file called `index.js.map` no longer overwrites, or
  gets overwritten by, the sourcemap of `index.js`.
- The reference search was case-insensitive while the roots it fed were not, so
  an oddly cased path counted as skipped and left a whole file unpatched.


### Changed

- `FileRegion` and `ExtractedRegion` carry `path`, where the region lands if it
  is written out. The manifest gains the same field for sourcemaps and bytecode.
- Patching looks 64 characters either side of a literal rather than 8, so
  indented source is patched rather than left as packed.
- `ManifestBinary` and `BinaryResult` are exported, so the public API no longer
  needs `ReturnType` to name what it returns.
- `--list` says it lists the packed files, matching the vocabulary the rest of
  the tool uses.
- The readme was rewritten for clarity. The opening says what the tool does and
  how unpacking differs from decompiling a Bun binary.
- The package description and keywords cover that wording too.
- Tests and the smoke script write to `.tmp/` inside the repository instead of
  the system temp directory, so scratch files stay next to the project and a
  failed run leaves them where you can look.


## [0.5.2]


### Fixed

- A stray code fence in the readme swallowed the paragraphs after the example,
  which also still described functions that 0.5.0 removed.


## [0.5.1]


### Changed

- Documentation only. The example shows the two loops it actually is, one over
  the images and one over the files of an image, and `readSlice` says why
  reading is per image rather than per file.


## [0.5.0]


### Changed

- `processSlice` and `writeSliceFs` are gone. One was `files.map(processFile)`
  and the other was that loop plus assembling a manifest, so the loop goes back
  to the caller and the assembling becomes `buildManifest`, which takes
  whatever records were collected.
- `describeFile` produces the record of a file that was not written, so
  listing and writing build the same manifest through the same function.


## [0.4.1]


### Changed

- The report says files rather than modules, matching what everything else
  calls them.


## [0.4.0]


### Changed

- The library is built around files rather than slices. `processFile` and
  `writeFile` operate on one file, and `processSlice` and `writeSliceFs` are
  loops over them, so a caller wanting one file out of a binary no longer has
  to write all of them.
- What you get is called a file rather than a module: `Payload.files`,
  `PayloadFile`, `ExtractedFile`, and `files` with `fileCount` in the manifest.
  The packer's own structures keep their name, `moduleEntrySize` is the stride
  of its module table.
- A file's `sourcemap` and `bytecode` carry `offsetInFile`, so it is
  self-contained and does not need the payload it came from to be read.


## [0.3.1]


### Changed

- Rewriting no longer reads a module into memory. The substitution happens
  chunk by chunk inside the copy loop, keeping back enough bytes that a
  reference straddling a boundary is still matched, so memory is bounded by the
  chunk rather than by the file.
- `.mjs` and `.cjs` are rewritten as well as `.js`. Nothing else is: turning a
  string literal into an expression is meaningless outside JavaScript.
- `PayloadModule.rewrittenReferences` became `rewrite`, the plan rather than a
  count, since the count is only known once the bytes have gone past.
- The README documents every export, with signatures, and its snippets run as
  written.


## [0.3.0]


### Changed

- Reading, processing and writing are now three steps instead of one function
  with a flag. `readSlice` returns the modules with their byte ranges, each
  able to hand back its own contents through `bytes()` or `stream()`, and
  writes nothing. `processSlice` rewrites the packed references and returns a
  payload carrying the patched contents. `writeSliceFs` performs the side
  effect and returns the manifest, which is where a manifest belongs.
- `extractSlice` and `ExtractOptions` are gone, along with the `write` flag
  that turned one function into two different operations.
- The flag that controls rewriting is `--path-patching <true|false>`, default
  true, replacing `--verbatim`. The name says what it does rather than what it
  refuses to do, and its help text explains the packer paths it exists for.
- `Manifest.binary` is `ManifestBinary`, a named type rather than an inline one.


### Added

- `Payload`, `PayloadModule`, `ProcessOptions` and `WriteOptions` in the public
  types.


## [0.2.0]


### Added

- References to the packer's virtual filesystem are rewritten to point at the
  extracted files, so an extracted bundle can find its assets and its native
  addons. They become `__dirname` expressions rather than absolute paths, which
  keeps the output directory movable. `--path-patching false` writes every
  file exactly as packed.
- `sha256Packed` and `rewrittenReferences` in the manifest, so the packed bytes
  remain verifiable against the binary even when the file on disk differs.


### Changed

- `UnpackOptions` gained a required `patchPaths` field.


## [0.1.1]


### Changed

- Documentation only. Names the Bun release the tested binaries were built
  with, and drops the pointer to one particular downstream wrapper.


## [0.1.0]

First release.


### Added

- Extraction of the embedded module graph from Bun single-file executables:
  the JavaScript bundle, native addons, sourcemaps and any other packed asset.
- Container support for ELF, thin Mach-O, universal Mach-O and PE, with the
  architecture reported for both the executable and every embedded addon. Each
  slice of a universal binary is extracted into its own directory.
- Probing of the offsets-struct size and the module table stride, validated
  against the packer path of the first entry, so the parser tolerates Bun
  releases that reshape those structures.
- `manifest.json` next to the output, recording virtual paths, sizes, sha256,
  file offsets and the raw bytes of every module table entry.
- `--list`, `--json`, `--bytecode` and `--out` flags.
- A programmatic API: `BinaryReader`, `inspectContainer`, `extractSlice`, plus
  `unpackBinary` and `unpackTargets` for tools that wrap this CLI with their
  own way of finding binaries.

[Unreleased]: https://github.com/Enuvid/bun-unpacker/compare/v0.12.1...HEAD
[0.12.1]: https://github.com/Enuvid/bun-unpacker/compare/v0.12.0...v0.12.1
[0.12.0]: https://github.com/Enuvid/bun-unpacker/compare/v0.11.0...v0.12.0
[0.11.0]: https://github.com/Enuvid/bun-unpacker/compare/v0.10.1...v0.11.0
[0.10.1]: https://github.com/Enuvid/bun-unpacker/compare/v0.10.0...v0.10.1
[0.10.0]: https://github.com/Enuvid/bun-unpacker/compare/v0.9.1...v0.10.0
[0.9.1]: https://github.com/Enuvid/bun-unpacker/compare/v0.9.0...v0.9.1
[0.9.0]: https://github.com/Enuvid/bun-unpacker/compare/v0.8.2...v0.9.0
[0.8.2]: https://github.com/Enuvid/bun-unpacker/compare/v0.8.1...v0.8.2
[0.8.1]: https://github.com/Enuvid/bun-unpacker/compare/v0.8.0...v0.8.1
[0.8.0]: https://github.com/Enuvid/bun-unpacker/compare/v0.7.1...v0.8.0
[0.7.1]: https://github.com/Enuvid/bun-unpacker/compare/v0.7.0...v0.7.1
[0.7.0]: https://github.com/Enuvid/bun-unpacker/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/Enuvid/bun-unpacker/compare/v0.5.2...v0.6.0
[0.5.2]: https://github.com/Enuvid/bun-unpacker/compare/v0.5.1...v0.5.2
[0.5.1]: https://github.com/Enuvid/bun-unpacker/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/Enuvid/bun-unpacker/compare/v0.4.1...v0.5.0
[0.4.1]: https://github.com/Enuvid/bun-unpacker/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/Enuvid/bun-unpacker/compare/v0.3.1...v0.4.0
[0.3.1]: https://github.com/Enuvid/bun-unpacker/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/Enuvid/bun-unpacker/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/Enuvid/bun-unpacker/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/Enuvid/bun-unpacker/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/Enuvid/bun-unpacker/releases/tag/v0.1.0
