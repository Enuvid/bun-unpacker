import { createReadStream } from 'node:fs';
import { extname } from 'node:path';
import type { Readable } from 'node:stream';
import type { BinaryReader } from './binary-reader.js';
import { HEADER_PROBE_SIZE, describeContents } from './container.js';
import {
  findPayloadTrailer,
  readModuleTable,
  readPayloadLayout,
  toRelativePath,
} from './payload.js';
import type {
  ContainerInfo,
  FileRegion,
  ImageSlice,
  Payload,
  PayloadFile,
  Region,
} from './types.js';

export const MANIFEST_FILE_NAME = 'manifest.json';
export const BYTECODE_DIRECTORY = '_bytecode';

/**
 * Two virtual paths can collapse onto one relative path, and a module could be
 * named after a file the writer produces itself, including the sourcemap and
 * bytecode sidecars. Either way the first one wins and the rest take a suffix,
 * so nothing is silently overwritten.
 */
function uniquePath(candidate: string, taken: Set<string>): string {
  if (!taken.has(candidate)) {
    taken.add(candidate);
    return candidate;
  }
  const extension = extname(candidate);
  const stem = candidate.slice(0, candidate.length - extension.length);
  for (let suffix = 1; ; suffix += 1) {
    const alternative = `${stem}-${suffix}${extension}`;
    if (!taken.has(alternative)) {
      taken.add(alternative);
      return alternative;
    }
  }
}

/**
 * Parses one image of an executable and returns its payload. Nothing is
 * written: each module carries its own byte range and reads it on demand.
 */
export function readSlice(
  reader: BinaryReader,
  container: ContainerInfo,
  slice: ImageSlice,
): Payload {
  const trailerOffset = findPayloadTrailer(reader, slice);
  const layout = readPayloadLayout(reader, slice, trailerOffset);
  const { entrySize, modules } = readModuleTable(reader, layout);

  const taken = new Set([MANIFEST_FILE_NAME, BYTECODE_DIRECTORY]);

  const read = (region: Region): Buffer =>
    reader.read(layout.blobStart + region.offset, region.length);

  const open = (region: Region): Readable =>
    createReadStream(reader.filePath, {
      start: layout.blobStart + region.offset,
      end: layout.blobStart + region.offset + region.length - 1,
    });

  const toFileRegion = (region: Region | null, path: string): FileRegion | null =>
    region === null
      ? null
      : {
          ...region,
          offsetInFile: layout.blobStart + region.offset,
          path: uniquePath(path, taken),
        };

  const files: PayloadFile[] = modules.map((module) => {
    const contentsOffsetInFile = layout.blobStart + module.contents.offset;
    const probe = reader.read(
      contentsOffsetInFile,
      Math.min(HEADER_PROBE_SIZE, module.contents.length),
    );

    const path = uniquePath(toRelativePath(module.name), taken);

    return {
      name: module.name,
      path,
      kind: describeContents(module.name, probe),
      size: module.contents.length,
      offsetInBlob: module.contents.offset,
      offsetInFile: contentsOffsetInFile,
      sourcemap: toFileRegion(module.sourcemap, `${path}.map`),
      bytecode: toFileRegion(module.bytecode, `${BYTECODE_DIRECTORY}/${path}.jsc`),
      rawEntryHex: module.rawEntryHex,
      rewrite: null,
      bytes: () => read(module.contents),
      stream: (region) => open(region ?? module.contents),
    };
  });

  return {
    reader,
    binary: {
      path: reader.filePath,
      size: reader.size,
      modifiedAt: reader.modifiedAt.toISOString(),
      container: container.format,
      architecture: slice.architecture ?? container.architecture,
      slice: container.isUniversal ? { start: slice.start, size: slice.size } : null,
    },
    layout,
    moduleEntrySize: entrySize,
    files,
  };
}
