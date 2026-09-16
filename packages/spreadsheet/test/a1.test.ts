import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { SPREADSHEET_LIMITS } from '@nessie/schemas'

import {
  cellA1,
  clampRange,
  rangeContains,
  rangeToCells,
  rangesOverlap,
  rectangleOf,
  requireSheetIndex,
  resolveSheetIndex,
} from '../src/a1.js'
import { SpreadsheetEngineError } from '../src/engine.js'

describe('a1', () => {
  it('enumerates a range row-major', () => {
    const cells = rangeToCells({ r0: 2, c0: 2, r1: 3, c1: 3 })
    assert.deepEqual(
      cells.map((cell) => cell.a1),
      ['B2', 'C2', 'B3', 'C3'],
    )
  })

  it('refuses a range past the read cap rather than truncating it', () => {
    const range = { r0: 1, c0: 1, r1: SPREADSHEET_LIMITS.maxCellsPerRead + 1, c1: 1 }
    assert.throws(
      () => rangeToCells(range),
      (error: unknown) => error instanceof SpreadsheetEngineError && error.code === 'SPREADSHEET_TOO_LARGE',
    )
    assert.equal(rangeToCells(range, { max: 20_000 }).length, SPREADSHEET_LIMITS.maxCellsPerRead + 1)
  })

  it('clamps to whole rows, and to columns when one row is already too wide', () => {
    const wide = clampRange({ r0: 1, c0: 1, r1: 100, c1: 10 }, 25)
    assert.deepEqual(wide, { range: { r0: 1, c0: 1, r1: 2, c1: 10 }, truncated: true })
    const tooWide = clampRange({ r0: 1, c0: 1, r1: 100, c1: 500 }, 25)
    assert.deepEqual(tooWide, { range: { r0: 1, c0: 1, r1: 1, c1: 25 }, truncated: true })
    assert.deepEqual(clampRange({ r0: 1, c0: 1, r1: 2, c1: 2 }, 25).truncated, false)
  })

  it('lets an exact sheet name beat a case-insensitive one', () => {
    const names = ['Data', 'data', 'Summary']
    assert.equal(resolveSheetIndex(names, 'data'), 1)
    assert.equal(resolveSheetIndex(names, 'Data'), 0)
    assert.equal(resolveSheetIndex(names, 'DATA'), 0)
    assert.equal(resolveSheetIndex(names, ' Summary '), 2)
    assert.equal(resolveSheetIndex(names, 'nope'), -1)
  })

  it('names the sheets it has when a lookup misses', () => {
    assert.throws(
      () => requireSheetIndex(['Data'], 'Nope'),
      (error: unknown) => error instanceof SpreadsheetEngineError && /"Data"/.test(error.message),
    )
  })

  it('formats cells and rectangles', () => {
    assert.equal(cellA1(5, 28), 'AB5')
    assert.deepEqual(rectangleOf(2, { r0: 1, c0: 1, r1: 2, c1: 2 }), { sheet: 2, r0: 1, c0: 1, r1: 2, c1: 2 })
    assert.equal(rangesOverlap({ r0: 1, c0: 1, r1: 3, c1: 3 }, { r0: 3, c0: 3, r1: 9, c1: 9 }), true)
    assert.equal(rangesOverlap({ r0: 1, c0: 1, r1: 3, c1: 3 }, { r0: 4, c0: 4, r1: 9, c1: 9 }), false)
    assert.equal(rangeContains({ r0: 1, c0: 1, r1: 3, c1: 3 }, 2, 2), true)
    assert.equal(rangeContains({ r0: 1, c0: 1, r1: 3, c1: 3 }, 4, 2), false)
  })
})
