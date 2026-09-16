import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { SpreadsheetEngineError } from '../src/engine.js'
import { exportCsv, importCsv, parseCsv } from '../src/csv.js'
import { createNodeModel } from '../src/node.js'
import { runPaused } from '../src/write.js'

describe('parseCsv', () => {
  it('handles quoted fields, embedded commas, newlines and doubled quotes', () => {
    assert.deepEqual(parseCsv('a,b\n1,2'), [
      ['a', 'b'],
      ['1', '2'],
    ])
    assert.deepEqual(parseCsv('"a,b",c'), [['a,b', 'c']])
    assert.deepEqual(parseCsv('"line\nbreak",c'), [['line\nbreak', 'c']])
    assert.deepEqual(parseCsv('"say ""hi""",c'), [['say "hi"', 'c']])
    assert.deepEqual(parseCsv('a,,c'), [['a', '', 'c']])
  })

  it('accepts CRLF and a BOM', () => {
    assert.deepEqual(parseCsv('﻿a,b\r\n1,2\r\n'), [
      ['a', 'b'],
      ['1', '2'],
    ])
  })

  it('sniffs a semicolon or tab delimiter from the first line', () => {
    assert.deepEqual(parseCsv('a;b;c\n1;2;3'), [
      ['a', 'b', 'c'],
      ['1', '2', '3'],
    ])
    assert.deepEqual(parseCsv('a\tb\n1\t2'), [
      ['a', 'b'],
      ['1', '2'],
    ])
    // A delimiter inside quotes does not count towards the sniff.
    assert.deepEqual(parseCsv('"a;b",c\n1,2'), [
      ['a;b', 'c'],
      ['1', '2'],
    ])
    assert.deepEqual(parseCsv('a;b\n1;2', { delimiter: ',' }), [['a;b'], ['1;2']])
  })

  it('returns nothing for empty input', () => {
    assert.deepEqual(parseCsv(''), [])
  })
})

describe('importCsv', () => {
  it('writes a comma-separated block, which pasteCsvString could not', () => {
    const model = createNodeModel('csv')
    const result = importCsv(model, { sheet: 0, csv: 'a,b,c\n1,2,3' })
    assert.deepEqual(result.range, { r0: 1, c0: 1, r1: 2, c1: 3 })
    assert.equal(result.summary.cellCount, 6)
    assert.equal(model.cellContent(0, 1, 1), 'a')
    assert.equal(model.cellContent(0, 1, 3), 'c')
    assert.equal(model.formattedValue(0, 2, 3), '3')
    // The engine coerces: `3` is a number, not text.
    assert.equal(model.cellType(0, 2, 3), 1)
  })

  it('anchors where it is told and pads ragged rows', () => {
    const model = createNodeModel('csv')
    importCsv(model, { sheet: 0, csv: 'a,b,c\nd', anchor: { row: 3, column: 2 } })
    assert.equal(model.cellContent(0, 3, 2), 'a')
    assert.equal(model.cellContent(0, 4, 2), 'd')
    assert.equal(model.cellContent(0, 4, 4), '')
  })

  it('keeps a formula-looking field as text when asked', () => {
    const model = createNodeModel('csv')
    importCsv(model, { sheet: 0, csv: '=1+1\n=SUM(A1)', asText: true })
    assert.equal(model.formattedValue(0, 1, 1), '=1+1')
    const live = createNodeModel('csv2')
    importCsv(live, { sheet: 0, csv: '=1+1' })
    assert.equal(live.formattedValue(0, 1, 1), '2')
  })

  it('refuses a CSV past the write limit', () => {
    const model = createNodeModel('csv')
    const csv = Array.from({ length: 2000 }, () => 'a,b,c,d,e,f,g,h,i,j').join('\n')
    assert.throws(
      () => importCsv(model, { sheet: 0, csv }),
      (error: unknown) => error instanceof SpreadsheetEngineError && error.code === 'SPREADSHEET_TOO_LARGE',
    )
  })
})

describe('exportCsv', () => {
  it('writes formatted values with RFC 4180 quoting', () => {
    const model = createNodeModel('out')
    runPaused(model, () => {
      model.setUserInput(0, 1, 1, 'plain')
      model.setUserInput(0, 1, 2, 'has,comma')
      model.setUserInput(0, 2, 1, 'say "hi"')
      model.setUserInput(0, 2, 2, '=1+1')
    })
    assert.equal(exportCsv(model, 0), 'plain,"has,comma"\n"say ""hi""",2')
    assert.equal(exportCsv(model, 0, { newline: '\r\n', bom: true }), '﻿plain,"has,comma"\r\n"say ""hi""",2')
  })

  it('round-trips through importCsv', () => {
    const source = createNodeModel('rt')
    runPaused(source, () => {
      source.setUserInput(0, 1, 1, 'a,b')
      source.setUserInput(0, 1, 2, 'line\nbreak')
      source.setUserInput(0, 2, 1, '7')
    })
    const target = createNodeModel('rt2')
    importCsv(target, { sheet: 0, csv: exportCsv(source, 0), delimiter: ',', asText: true })
    assert.equal(target.formattedValue(0, 1, 1), 'a,b')
    assert.equal(target.formattedValue(0, 1, 2), 'line\nbreak')
  })

  it('exports hidden rows, because a filter is a view and not a deletion', () => {
    const model = createNodeModel('hidden')
    runPaused(model, () => {
      model.setUserInput(0, 1, 1, 'kept')
      model.setUserInput(0, 2, 1, 'hidden')
      model.setRowsHidden(0, 2, 2, true)
    })
    assert.equal(model.isRowHidden(0, 2), true)
    assert.equal(exportCsv(model, 0), 'kept\nhidden')
  })

  it('returns an empty string for an empty sheet', () => {
    assert.equal(exportCsv(createNodeModel('empty'), 0), '')
  })
})
