export { BinaryReader } from './binary-reader.js';
export { ContainerError, describeContents, inspectContainer } from './container.js';
export { extractSlice, writeManifest } from './extract.js';
export type { ExtractOptions } from './extract.js';
export { formatBytes, renderTable } from './format.js';
export {
  DEFAULT_OUTPUT_DIR,
  UsageError,
  asUsageError,
  parseArguments,
  requireAtMostOneBinary,
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
export type { BinaryResult, Streams, UnpackOptions } from './run.js';
export { TOOL_VERSION } from './version.js';
export type {
  ContainerInfo,
  ExecutableFormat,
  ExtractedModule,
  ExtractedRegion,
  ImageSlice,
  Manifest,
  PayloadLayout,
  Region,
} from './types.js';
