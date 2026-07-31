import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { formatBytes, renderTable } from '../src/format.js';

describe('formatBytes', () => {
  it('switches unit at the 1024 boundary', () => {
    assert.equal(formatBytes(0), '0 B');
    assert.equal(formatBytes(1023), '1023 B');
    assert.equal(formatBytes(1024), '1.00 KB');
    assert.equal(formatBytes(1024 * 1024), '1.00 MB');
    assert.equal(formatBytes(1024 ** 3), '1.00 GB');
  });

  it('drops a decimal place once the number is wide enough', () => {
    assert.equal(formatBytes(10 * 1024), '10.0 KB');
    assert.equal(formatBytes(9.5 * 1024), '9.50 KB');
  });

  it('stops at the largest known unit', () => {
    assert.equal(formatBytes(1024 ** 5), '1024.0 TB');
  });
});

describe('renderTable', () => {
  it('pads columns to the widest cell and right-aligns on request', () => {
    const lines = renderTable(
      ['path', 'size'],
      [
        ['a.js', '7 B'],
        ['much-longer.js', '1.00 KB'],
      ],
      new Set([1]),
    );

    assert.deepEqual(lines, [
      '  path               size',
      '  --------------  -------',
      '  a.js                7 B',
      '  much-longer.js  1.00 KB',
    ]);
  });

  it('tolerates rows shorter than the header', () => {
    assert.deepEqual(renderTable(['a', 'b'], [['only']]), ['  a     b', '  ----  -', '  only']);
  });
});
