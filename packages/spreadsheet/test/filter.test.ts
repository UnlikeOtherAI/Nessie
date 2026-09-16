import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { SpreadsheetFilterModelSchema, type SpreadsheetFilterModel } from '@nessie/schemas'

import type { SpreadsheetEngineModel } from '../src/engine.js'
import {
  applyFilter,
  clearFilter,
  emptyFilter,
  hiddenRowsFor,
  matchesColumn,
  remapFilter,
  remapFilters,
  remapSheetIndex,
  structuralEditsFromSummary,
  type SpreadsheetStructuralEdit,
} from '../src/filter.js'
import { createNodeModel } from '../src/node.js'
import { restructure, runPaused } from '../src/write.js'

const ROWS: [string, string, string][] = [
  ['Name', 'Region', 'Qty'],
  ['pear', 'North', '3'],
  ['apple', 'South', '10'],
  ['cherry', 'North', ''],
  ['banana', 'East', '7'],
  ['fig', 'South', '1'],
]

function sheet(): SpreadsheetEngineModel {
  const model = createNodeModel('filter')
  runPaused(model, () => {
    ROWS.forEach((row, r) => row.forEach((value, c) => model.setUserInput(0, r + 1, c + 1, value)))
  })
  return model
}

const RANGE = { r0: 1, c0: 1, r1: 6, c1: 3 }

function withColumns(columns: SpreadsheetFilterModel['columns']): SpreadsheetFilterModel {
  return { ...emptyFilter(RANGE), columns }
}

describe('filter criteria', () => {
  const matrix: [string, SpreadsheetFilterModel['columns'][string], string, boolean][] = [
    ['values hit', { kind: 'values', values: ['North'], blanks: false }, 'North', true],
    ['values miss', { kind: 'values', values: ['North'], blanks: false }, 'South', false],
    ['values blank excluded', { kind: 'values', values: ['North'], blanks: false }, '', false],
    ['values blank included', { kind: 'values', values: [], blanks: true }, '', true],
    ['eq numeric', { kind: 'condition', op: 'eq', value: 10 }, '10', true],
    ['eq numeric as text', { kind: 'condition', op: 'eq', value: '10' }, '10.0', true],
    ['eq text', { kind: 'condition', op: 'eq', value: 'north' }, 'North', true],
    ['eq text cased', { kind: 'condition', op: 'eq', value: 'north', caseSensitive: true }, 'North', false],
    ['ne', { kind: 'condition', op: 'ne', value: 3 }, '4', true],
    ['gt', { kind: 'condition', op: 'gt', value: 3 }, '10', true],
    ['gt lexical fallback', { kind: 'condition', op: 'gt', value: 'b' }, 'c', true],
    ['gte', { kind: 'condition', op: 'gte', value: 3 }, '3', true],
    ['lt', { kind: 'condition', op: 'lt', value: 3 }, '2', true],
    ['lte', { kind: 'condition', op: 'lte', value: 3 }, '4', false],
    ['contains', { kind: 'condition', op: 'contains', value: 'or' }, 'North', true],
    ['notContains', { kind: 'condition', op: 'notContains', value: 'or' }, 'South', true],
    ['startsWith', { kind: 'condition', op: 'startsWith', value: 'no' }, 'North', true],
    ['endsWith', { kind: 'condition', op: 'endsWith', value: 'th' }, 'North', true],
    ['empty', { kind: 'condition', op: 'empty' }, '', true],
    ['notEmpty', { kind: 'condition', op: 'notEmpty' }, 'x', true],
    ['between numeric', { kind: 'condition', op: 'between', value: 2, value2: 8 }, '7', true],
    ['between numeric out', { kind: 'condition', op: 'between', value: 2, value2: 8 }, '9', false],
    ['between reversed bounds', { kind: 'condition', op: 'between', value: 8, value2: 2 }, '7', true],
    ['between text', { kind: 'condition', op: 'between', value: 'a', value2: 'c' }, 'b', true],
  ]

  for (const [name, criterion, cell, expected] of matrix) {
    it(`${name}`, () => {
      assert.equal(matchesColumn(criterion, cell), expected)
    })
  }
})

describe('filter application', () => {
  it('hides only the rows the criteria reject, and the header never', () => {
    const model = sheet()
    const filter = withColumns({ '2': { kind: 'values', values: ['North'], blanks: false } })
    assert.deepEqual(hiddenRowsFor(model, 0, filter), [3, 5, 6])
    const applied = applyFilter(model, 0, filter, '12')
    assert.deepEqual(applied.hidden, [3, 5, 6])
    assert.deepEqual(applied.filter.hiddenRows, [3, 5, 6])
    assert.equal(applied.filter.appliedAtSeq, '12')
    assert.equal(model.isRowHidden(0, 1), false)
    assert.equal(model.isRowHidden(0, 2), false)
    assert.equal(model.isRowHidden(0, 3), true)
    assert.equal(model.isRowHidden(0, 4), false)
  })

  it('never unhides a manual hide, only the rows it hid itself', () => {
    const model = sheet()
    // Somebody hides row 2 by hand. The filter has never touched it.
    restructure(model, { kind: 'setRowsHidden', sheet: 0, start: 2, end: 2, hidden: true })
    const first = applyFilter(model, 0, withColumns({ '2': { kind: 'values', values: ['North'], blanks: false } }))
    assert.equal(model.isRowHidden(0, 2), true, 'the manual hide survived the filter')
    // Now widen the criteria so the filter wants nothing hidden.
    const widened = { ...first.filter, columns: { '2': { kind: 'values' as const, values: ['North', 'South', 'East'], blanks: true } } }
    const second = applyFilter(model, 0, widened)
    assert.deepEqual(second.shown, [3, 5, 6])
    assert.equal(model.isRowHidden(0, 2), true, 'the manual hide is still not the filter’s to undo')
    assert.equal(model.isRowHidden(0, 3), false)
  })

  it('clearing unhides exactly what the filter hid', () => {
    const model = sheet()
    restructure(model, { kind: 'setRowsHidden', sheet: 0, start: 2, end: 2, hidden: true })
    const applied = applyFilter(model, 0, withColumns({ '2': { kind: 'values', values: ['North'], blanks: false } }))
    const cleared = clearFilter(model, 0, applied.filter)
    assert.deepEqual(cleared.shown, [3, 5, 6])
    assert.deepEqual(cleared.filter.hiddenRows, [])
    assert.deepEqual(cleared.filter.columns, {})
    assert.equal(model.isRowHidden(0, 2), true)
    assert.equal(model.isRowHidden(0, 3), false)
  })

  it('ANDs several columns', () => {
    const model = sheet()
    const filter = withColumns({
      '2': { kind: 'values', values: ['North', 'South'], blanks: false },
      '3': { kind: 'condition', op: 'gte', value: 3 },
    })
    assert.deepEqual(hiddenRowsFor(model, 0, filter), [4, 5, 6])
  })

  it('an empty criteria set hides nothing', () => {
    const model = sheet()
    assert.deepEqual(hiddenRowsFor(model, 0, emptyFilter(RANGE)), [])
  })

  it('round-trips through its persisted schema', () => {
    const filter = withColumns({ '2': { kind: 'values', values: ['North'], blanks: false } })
    assert.deepEqual(SpreadsheetFilterModelSchema.parse(JSON.parse(JSON.stringify(filter))), filter)
  })
})

describe('filter remap', () => {
  const base: SpreadsheetFilterModel = {
    range: { r0: 5, c0: 2, r1: 20, c1: 6 },
    columns: { '3': { kind: 'values', values: ['x'], blanks: false } },
    sort: { column: 4, direction: 'asc' },
    hiddenRows: [8, 9],
    appliedAtSeq: '1',
  }

  const cases: [string, SpreadsheetStructuralEdit, Partial<SpreadsheetFilterModel> | null][] = [
    [
      'insertRows above',
      { kind: 'insertRows', sheet: 0, row: 2, count: 3 },
      { range: { r0: 8, c0: 2, r1: 23, c1: 6 }, hiddenRows: [11, 12] },
    ],
    [
      'insertRows inside',
      { kind: 'insertRows', sheet: 0, row: 10, count: 2 },
      { range: { r0: 5, c0: 2, r1: 22, c1: 6 }, hiddenRows: [8, 9] },
    ],
    [
      'insertRows below',
      { kind: 'insertRows', sheet: 0, row: 30, count: 2 },
      { range: { r0: 5, c0: 2, r1: 20, c1: 6 } },
    ],
    [
      'deleteRows above',
      { kind: 'deleteRows', sheet: 0, row: 1, count: 2 },
      { range: { r0: 3, c0: 2, r1: 18, c1: 6 }, hiddenRows: [6, 7] },
    ],
    [
      'deleteRows over some hidden rows',
      { kind: 'deleteRows', sheet: 0, row: 8, count: 1 },
      { range: { r0: 5, c0: 2, r1: 19, c1: 6 }, hiddenRows: [8] },
    ],
    ['deleteRows over the whole range', { kind: 'deleteRows', sheet: 0, row: 1, count: 40 }, null],
    [
      'insertColumns before the keys',
      { kind: 'insertColumns', sheet: 0, column: 1, count: 1 },
      { range: { r0: 5, c0: 3, r1: 20, c1: 7 }, columns: { '4': { kind: 'values', values: ['x'], blanks: false } } },
    ],
    [
      'deleteColumns removing the criteria column',
      { kind: 'deleteColumns', sheet: 0, column: 3, count: 1 },
      { range: { r0: 5, c0: 2, r1: 20, c1: 5 }, columns: {} },
    ],
    ['deleteColumns over the whole range', { kind: 'deleteColumns', sheet: 0, column: 1, count: 20 }, null],
    [
      'moveRows inside the range',
      { kind: 'moveRows', sheet: 0, start: 8, count: 1, delta: 5 },
      { range: { r0: 5, c0: 2, r1: 20, c1: 6 }, hiddenRows: [8, 13] },
    ],
    [
      'moveColumns inside the range',
      { kind: 'moveColumns', sheet: 0, start: 3, count: 1, delta: 2 },
      { columns: { '5': { kind: 'values', values: ['x'], blanks: false } } },
    ],
    ['an edit on another sheet', { kind: 'insertRows', sheet: 1, row: 1, count: 5 }, {}],
    ['adding a sheet', { kind: 'addSheet', index: 3 }, {}],
    ['deleting this sheet', { kind: 'deleteSheet', index: 0 }, null],
    ['deleting another sheet', { kind: 'deleteSheet', index: 4 }, {}],
    ['moving a sheet', { kind: 'moveSheet', from: 2, to: 0 }, {}],
  ]

  for (const [name, edit, expected] of cases) {
    it(`remaps under ${name}`, () => {
      const moved = remapFilter(base, 0, edit)
      if (expected === null) {
        assert.equal(moved, null)
        return
      }
      assert.notEqual(moved, null)
      for (const [key, value] of Object.entries(expected)) {
        assert.deepEqual((moved as unknown as Record<string, unknown>)[key], value, `${name}: ${key}`)
      }
    })
  }

  it('re-keys the per-sheet map when a sheet is added, moved or deleted', () => {
    const filters = { '0': base, '2': base }
    assert.deepEqual(Object.keys(remapFilters(filters, { kind: 'addSheet', index: 0 })), ['1', '3'])
    assert.deepEqual(Object.keys(remapFilters(filters, { kind: 'deleteSheet', index: 0 })), ['1'])
    assert.deepEqual(Object.keys(remapFilters(filters, { kind: 'moveSheet', from: 2, to: 0 })), ['0', '1'])
    assert.equal(remapSheetIndex(1, { kind: 'moveSheet', from: 2, to: 0 }), 2)
  })

  it('reads the structural edits back out of a batch summary', () => {
    const edits = structuralEditsFromSummary({
      structuralKind: 'insertRows',
      sheetIndexes: [0],
      cellCount: 0,
      touched: [],
      intents: [
        { kind: 'insertRows', sheet: 0, row: 4, count: 2 },
        { kind: 'setUserInput', sheet: 0, row: 1, column: 1, value: 'x' },
      ],
    })
    assert.deepEqual(edits, [{ kind: 'insertRows', sheet: 0, row: 4, count: 2 }])
    // A server-built batch carries no intents, so there is nothing to remap by.
    assert.deepEqual(
      structuralEditsFromSummary({ structuralKind: 'insertRows', sheetIndexes: [0], cellCount: 0, touched: [] }),
      [],
    )
  })
})
