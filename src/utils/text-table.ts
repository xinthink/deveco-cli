/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { green } from 'colorette';

export interface TableRow {
  cells: string[];
  highlight?: boolean;
}

function padCell(value: string, width: number): string {
  return value + ' '.repeat(Math.max(0, width - value.length));
}

function computeColumnWidths(
  headers: readonly string[],
  rows: TableRow[]
): number[] {
  return headers.map((header, index) => {
    let width = header.length;
    for (const row of rows) {
      const cell = row.cells[index] ?? '';
      width = Math.max(width, cell.length);
    }
    return width;
  });
}

export function renderTable(
  headers: readonly string[],
  rows: TableRow[]
): string {
  const widths = computeColumnWidths(headers, rows);
  const lines: string[] = [];
  lines.push(headers.map((h, i) => padCell(h, widths[i])).join('  '));
  lines.push(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const row of rows) {
    const line = row.cells
      .map((c, i) => padCell(c ?? '', widths[i]))
      .join('  ')
      .trimEnd();
    lines.push(row.highlight ? green(line) : line);
  }
  return lines.join('\n');
}
