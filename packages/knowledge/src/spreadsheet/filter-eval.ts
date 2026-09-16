import type { SpreadsheetEngineModel } from '@nessie/spreadsheet'

import type { SpreadsheetFilterColumn, SpreadsheetFilterModel } from './filter-model.js'

/**
 * Criteria evaluation and the hidden-row delta.
 *
 * TODO(Phase 1): `packages/spreadsheet/src/filter.ts` owns this in the plan.
 * This is the narrow version the filter routes need now — it evaluates the
 * same criteria against the same formatted values, and produces the same
 * delta shape — so deleting it in favour of that module is an import change.
 */

const asNumber = (value: string | number | undefined): number | null => {
  if (typeof value === 'number') return value
  if (value === undefined || value.trim() === '') return null
  const parsed = Number(value.replace(/[\s,]/g, ''))
  return Number.isFinite(parsed) ? parsed : null
}

const compare = (cell: string, criterion: SpreadsheetFilterColumn): boolean => {
  if (criterion.kind === 'values') {
    if (cell === '') return criterion.blanks
    return criterion.values.includes(cell)
  }
  const sensitive = criterion.caseSensitive === true
  const left = sensitive ? cell : cell.toLowerCase()
  const rawRight = criterion.value
  const right = sensitive
    ? String(rawRight ?? '')
    : String(rawRight ?? '').toLowerCase()
  const cellNumber = asNumber(cell)
  const valueNumber = asNumber(criterion.value)
  const value2Number = asNumber(criterion.value2)

  switch (criterion.op) {
    case 'empty':
      return cell === ''
    case 'notEmpty':
      return cell !== ''
    case 'eq':
      return cellNumber !== null && valueNumber !== null ? cellNumber === valueNumber : left === right
    case 'ne':
      return cellNumber !== null && valueNumber !== null ? cellNumber !== valueNumber : left !== right
    case 'gt':
      return cellNumber !== null && valueNumber !== null ? cellNumber > valueNumber : left > right
    case 'gte':
      return cellNumber !== null && valueNumber !== null ? cellNumber >= valueNumber : left >= right
    case 'lt':
      return cellNumber !== null && valueNumber !== null ? cellNumber < valueNumber : left < right
    case 'lte':
      return cellNumber !== null && valueNumber !== null ? cellNumber <= valueNumber : left <= right
    case 'contains':
      return left.includes(right)
    case 'notContains':
      return !left.includes(right)
    case 'startsWith':
      return left.startsWith(right)
    case 'endsWith':
      return left.endsWith(right)
    case 'between':
      if (cellNumber === null || valueNumber === null || value2Number === null) return false
      return (
        cellNumber >= Math.min(valueNumber, value2Number)
        && cellNumber <= Math.max(valueNumber, value2Number)
      )
    default:
      return true
  }
}

export type FilterDelta = {
  /** Rows the model now hides that were not hidden by it before. */
  hide: number[]
  /** Rows the model used to hide and no longer does — and only those. */
  unhide: number[]
  /** The new `hiddenRows` set for the stored model. */
  hiddenRows: number[]
}

/**
 * Evaluate a filter against the live formatted values.
 *
 * Only rows *this model* hid are ever unhidden. A row somebody hid by hand
 * outside the filter's own set stays hidden, which is the whole reason the
 * model records what it hid rather than recomputing "everything visible".
 */
export const evaluateFilter = (
  model: SpreadsheetEngineModel,
  sheet: number,
  filter: SpreadsheetFilterModel,
): FilterDelta => {
  const previous = new Set(filter.hiddenRows)
  const next = new Set<number>()
  const criteria = Object.entries(filter.columns)
    .map(([key, criterion]) => ({ column: Number(key), criterion }))
    .filter((entry) => Number.isFinite(entry.column))

  // The header row (`r0`) is never filtered out.
  for (let row = filter.range.r0 + 1; row <= filter.range.r1; row++) {
    const visible = criteria.every(({ column, criterion }) =>
      compare(model.formattedValue(sheet, row, column) ?? '', criterion),
    )
    if (!visible) next.add(row)
  }

  return {
    hide: [...next].filter((row) => !previous.has(row)).sort((a, b) => a - b),
    unhide: [...previous].filter((row) => !next.has(row)).sort((a, b) => a - b),
    hiddenRows: [...next].sort((a, b) => a - b),
  }
}

/** Contiguous runs, so a 10 000-row hide is a handful of engine calls. */
export const toRuns = (rows: number[]): { start: number; end: number }[] => {
  const runs: { start: number; end: number }[] = []
  for (const row of rows) {
    const last = runs[runs.length - 1]
    if (last && row === last.end + 1) last.end = row
    else runs.push({ start: row, end: row })
  }
  return runs
}
