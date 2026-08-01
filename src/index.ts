// The core: reading an executable, and writing what it holds back out.
export { BinaryReader } from './core/binary-reader.js';
export { ContainerError, describeContents, inspectContainer } from './core/container.js';
export { PayloadNotFoundError, PayloadParseError, toRelativePath } from './core/payload.js';
export { BYTECODE_DIRECTORY, MANIFEST_FILE_NAME, readSlice } from './core/read-slice.js';
export { processFile } from './core/process-slice.js';
export { createRewriteStream } from './core/rewrite.js';
export { buildManifest, describeFile, writeFile, writeManifest } from './core/write-slice-fs.js';
export { TOOL_VERSION } from './version.js';

export type { RewriteStream } from './core/rewrite.js';
export type {
  ContainerInfo,
  ExecutableFormat,
  ExtractedFile,
  ExtractedRegion,
  FileRegion,
  ImageSlice,
  Manifest,
  ManifestBinary,
  Payload,
  PayloadFile,
  PayloadLayout,
  ProcessOptions,
  Region,
  WriteOptions,
} from './core/types.js';

// What a wrapper needs to put its own front end on the same pipeline: the
// pipeline itself, the exit codes, the stream handles and the flag validators.
// The rest of src/cli stays inside, since a wrapper brings its own flags and
// its own reporting.
export {
  DEFAULT_OUTPUT_DIR,
  UsageError,
  asUsageError,
  requireAtMostOneBinary,
  requireBoolean,
  requireOutputDir,
} from './cli/options.js';
export {
  EXIT_FAILURE,
  EXIT_OK,
  EXIT_USAGE,
  consoleStreams,
  describeError,
  unpackBinary,
  unpackTargets,
} from './cli/run.js';

export type { BinaryResult, Streams, UnpackOptions } from './cli/run.js';
