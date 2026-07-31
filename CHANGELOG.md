# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).


## [Unreleased]


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

[Unreleased]: https://github.com/Enuvid/bun-unpacker/compare/v0.5.2...HEAD
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
