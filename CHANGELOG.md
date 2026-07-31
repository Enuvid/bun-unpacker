# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).


## [Unreleased]


## [0.3.0]


### Changed

- Reading a payload and writing it out are now separate. `readPayload` returns
  the modules with their byte ranges, each able to hand back its own contents
  through `bytes()` or `stream()`, and writes nothing. `writeModules` performs
  the side effect and returns the manifest, which is where a manifest belongs.
- `extractSlice` and `ExtractOptions` are gone, along with the `write` flag
  that turned one function into two different operations. Not writing now
  means not calling `writeModules`.
- `Manifest.binary` is `ManifestBinary`, a named type rather than an inline one.


### Added

- `Payload`, `PayloadModule` and `WriteOptions` in the public types.


## [0.2.0]


### Added

- References to the packer's virtual filesystem are rewritten to point at the
  extracted files, so an extracted bundle can find its assets and its native
  addons. They become `__dirname` expressions rather than absolute paths, which
  keeps the output directory movable. `--verbatim` opts out and writes every
  file exactly as packed.
- `sha256Packed` and `rewrittenReferences` in the manifest, so the packed bytes
  remain verifiable against the binary even when the file on disk differs.


### Changed

- `UnpackOptions` and `ExtractOptions` gained a required `verbatim` field.


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

[Unreleased]: https://github.com/Enuvid/bun-unpacker/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/Enuvid/bun-unpacker/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/Enuvid/bun-unpacker/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/Enuvid/bun-unpacker/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/Enuvid/bun-unpacker/releases/tag/v0.1.0
