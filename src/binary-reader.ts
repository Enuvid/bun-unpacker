import { closeSync, openSync, readSync, statSync } from 'node:fs';

const DEFAULT_SCAN_WINDOW = 8 * 1024 * 1024;

/**
 * Random-access reader over an executable. Descriptor based on purpose: the
 * binaries this targets run to a quarter of a gigabyte, and every lookup
 * touches a handful of bytes near a known offset.
 */
export class BinaryReader implements Disposable {
  #fileDescriptor: number;
  #closed = false;

  private constructor(
    fileDescriptor: number,
    readonly filePath: string,
    readonly size: number,
    readonly modifiedAt: Date,
  ) {
    this.#fileDescriptor = fileDescriptor;
  }

  static open(filePath: string): BinaryReader {
    const stats = statSync(filePath);
    if (!stats.isFile()) {
      throw new Error(`not a regular file: ${filePath}`);
    }
    return new BinaryReader(openSync(filePath, 'r'), filePath, stats.size, stats.mtime);
  }

  close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    closeSync(this.#fileDescriptor);
  }

  [Symbol.dispose](): void {
    this.close();
  }

  /**
   * A short read yields a shorter buffer rather than throwing, so callers can
   * probe near the end of a file without checking its length first.
   */
  read(position: number, length: number): Buffer {
    if (length <= 0) {
      return Buffer.alloc(0);
    }
    const buffer = Buffer.allocUnsafe(length);
    let filled = 0;
    while (filled < length) {
      const bytesRead = readSync(
        this.#fileDescriptor,
        buffer,
        filled,
        length - filled,
        position + filled,
      );
      if (bytesRead <= 0) {
        break;
      }
      filled += bytesRead;
    }
    return filled === length ? buffer : buffer.subarray(0, filled);
  }

  readText(position: number, length: number): string {
    return this.read(position, length).toString('utf8');
  }

  /**
   * Last occurrence of `needle` within `[from, to)`, or -1. Windows overlap by
   * `needle.length - 1` so a match straddling a boundary is still found.
   * `windowSize` exists for tests that need to cross a boundary cheaply.
   */
  findLast(needle: Buffer, from: number, to: number, windowSize = DEFAULT_SCAN_WINDOW): number {
    let windowEnd = to;
    for (;;) {
      const windowStart = Math.max(from, windowEnd - windowSize);
      const window = this.read(windowStart, windowEnd - windowStart);
      const index = window.lastIndexOf(needle);
      if (index !== -1) {
        return windowStart + index;
      }
      if (windowStart === from) {
        return -1;
      }
      windowEnd = windowStart + needle.length - 1;
    }
  }
}
