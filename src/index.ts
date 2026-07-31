export { BinaryReader } from './binary-reader.js';
export { ContainerError, describeContents, inspectContainer } from './container.js';
export { BYTECODE_DIRECTORY, MANIFEST_FILE_NAME, readSlice } from './read-slice.js';
export { processFile, processSlice } from './process-slice.js';
export { writeFile, writeManifest, writeSliceFs } from './write-slice-fs.js';
export { formatBytes, renderTable } from './format.js';
export {
  DEFAULT_OUTPUT_DIR,
  UsageError,
  asUsageError,
  parseArguments,
  requireAtMostOneBinary,
  requireBoolean,
  requireOutputDir,
} from './options.js';
export type { CliOptions } from './options.js';
export { PayloadNotFoundError, PayloadParseError, toRelativePath } from './payload.js';
export {
  EXIT_FAILURE,
  EXIT_OK,
  EXIT_USAGE,
  consoleStreams,
  describeError,
  reportSlice,
  unpackBinary,
  unpackTargets,
} from './run.js';
export type { Streams, UnpackOptions } from './run.js';
export { TOOL_VERSION } from './version.js';
export type {
  ContainerInfo,
  Payload,
  PayloadFile,
  ProcessOptions,
  WriteOptions,
  ExecutableFormat,
  ExtractedFile,
  FileRegion,
  ExtractedRegion,
  ImageSlice,
  Manifest,
  PayloadLayout,
  Region,
} from './types.js';
