const UNITS = ['KB', 'MB', 'GB', 'TB'] as const;

export function formatBytes(byteCount: number): string {
  if (byteCount < 1024) {
    return `${byteCount} B`;
  }
  let value = byteCount / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < UNITS.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(value < 10 ? 2 : 1)} ${UNITS[unitIndex]}`;
}

/** Renders a two-space indented text table, one string per line. */
export function renderTable(
  headers: string[],
  rows: string[][],
  rightAlignedColumns: ReadonlySet<number> = new Set(),
): string[] {
  const widths = headers.map((header, columnIndex) =>
    rows.reduce((widest, row) => Math.max(widest, (row[columnIndex] ?? '').length), header.length),
  );

  const renderRow = (cells: string[]): string =>
    `  ${cells
      .map((cell, columnIndex) => {
        const width = widths[columnIndex] ?? 0;
        return rightAlignedColumns.has(columnIndex) ? cell.padStart(width) : cell.padEnd(width);
      })
      .join('  ')
      .trimEnd()}`;

  const separator = `  ${widths.map((width) => '-'.repeat(width)).join('  ')}`;
  return [renderRow(headers), separator, ...rows.map(renderRow)];
}
