import { extname } from 'node:path';
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

/**
 * Prefixed and underscored so a packed file is unlikely to be named after it.
 * If one is, that file wins and no manifest is written: the point of the tool
 * is what the binary held, not what this adds.
 */
export const MANIFEST_FILE_NAME = '__unpack_manifest.json';
export const BYTECODE_DIRECTORY = '_bytecode';

/**
 * How much a stream reads per pull. Large enough that a 150 MB bytecode cache
 * does not turn into thousands of round trips, small enough to stay well under
 * what a caller is willing to hold.
 */
const STREAM_CHUNK_SIZE = 1024 * 1024;

/**
 * Two virtual paths can collapse onto one relative path, since the segments
 * that would escape the output directory are dropped. The first one keeps the
 * path and the rest take a suffix, so nothing is silently overwritten.
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

  const taken = new Set<string>();

  const read = (region: Region): Buffer =>
    reader.read(layout.blobStart + region.offset, region.length);

  /**
   * A pull stream over a region, so the consumer decides the pace and nothing
   * is read ahead of what it asks for. Buffer is a Uint8Array, so the bytes go
   * out as they were read, without a copy.
   */
  const open = (region: Region): ReadableStream<Uint8Array> => {
    let position = layout.blobStart + region.offset;
    const end = position + region.length;

    return new ReadableStream<Uint8Array>({
      pull(controller) {
        if (position >= end) {
          controller.close();
          return;
        }
        const chunk = reader.read(position, Math.min(STREAM_CHUNK_SIZE, end - position));
        if (chunk.length === 0) {
          throw new Error(`unexpected end of file at offset ${String(position)}`);
        }
        position += chunk.length;
        controller.enqueue(chunk);
      },
    });
  };

  const toFileRegion = (region: Region | null, path: string): FileRegion | null =>
    region === null
      ? null
      : {
          ...region,
          offsetInFile: layout.blobStart + region.offset,
          path: uniquePath(path, taken),
        };

  // Packed files claim their paths before anything else, so a sourcemap or a
  // bytecode dump never takes a name a packed file was going to land on. The
  // sidecars are this tool's own output and nothing in a bundle refers to
  // them, which makes them the ones that can afford to move.
  const paths = modules.map((module) => uniquePath(toRelativePath(module.name), taken));

  const files: PayloadFile[] = modules.map((module, index) => {
    const contentsOffsetInFile = layout.blobStart + module.contents.offset;
    const probe = reader.read(
      contentsOffsetInFile,
      Math.min(HEADER_PROBE_SIZE, module.contents.length),
    );

    const path = paths[index] ?? toRelativePath(module.name);

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
