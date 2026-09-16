// A prototype of the CSV export Phase 1's `csv.ts` owes: formatted values,
// RFC 4180 quoting, the sheet's used range.

import type { UserModel } from '@ironcalc/nodejs'

/** The CSV projection Phase 1's `csv.ts` owes: formatted values, RFC 4180. */
export function exportSheetCsv(model: UserModel, sheet: number): string {
  const [minRow, maxRow, minColumn, maxColumn] = model.getSheetDimensions(sheet)
  const lines: string[] = []
  for (let row = minRow; row <= maxRow; row++) {
    const cells: string[] = []
    for (let column = minColumn; column <= maxColumn; column++) {
      const value = model.getFormattedCellValue(sheet, row, column)
      cells.push(/[",\n\r]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value)
    }
    lines.push(cells.join(','))
  }
  return lines.join('\n')
}
