export { BinaryReader } from './core/binary-reader.js';
export {
  ContainerError,
  describeContents,
  inspectContainer,
  isJavaScript,
} from './core/container.js';
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
  ManifestOptions,
  PathPatching,
  Payload,
  PayloadFile,
  PayloadLayout,
  ProcessOptions,
  Region,
  WriteOptions,
} from './core/types.js';
