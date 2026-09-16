import assert from 'node:assert/strict'
import { before, describe, it } from 'node:test'

import { REF_ERROR, formulaParses, isFormula, shiftFormula, tokenizeFormula } from '../src/formula-shift.js'

import { mulberry32, rawWasm, type RawWasmForTests, type RawWasmModelForTests } from './support/engine.js'

// The verdict this file exists to give: for every fixture and every
// displacement, our splice-based rewrite equals what the engine itself produces
// when the same cell is copied and pasted. The oracle is
// `copyToClipboard()` + `pasteFromClipboard(…, false)` on @ironcalc/wasm 0.8.4,
// which is the same code path a person's Ctrl-C/Ctrl-V goes through.
//
// The fixtures are fed to the engine FIRST and read back before they are
// shifted. That is not a convenience: a paste re-prints the whole formula, so
// `= B5 * 2` comes back `=B5*2` and `=sum(a1:b2)` comes back `=SUM(A1:B2)`.
// Splicing deliberately leaves everything that is not a reference alone, so the
// two only agree on text the engine has already spelled its own way — which is
// every formula we ever shift, because they all come out of `cellContent`.

const BASE_ROW = 20
const BASE_COLUMN = 20

/** Twelve displacements: identity, the four neighbours, two diagonals, two long
 *  hops, and the three that push a reference off the grid into `#REF!`. */
const DISPLACEMENTS: [number, number][] = [
  [0, 0],
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [3, 3],
  [-3, -3],
  [10, 0],
  [0, 10],
  [-19, 0],
  [0, -19],
  [5, -2],
]

function buildFixtures(): string[] {
  const random = mulberry32(0x5ee_d1)
  const cells = ['A1', '$A$1', 'A$1', '$A1', 'B5', '$F$1', 'C12', 'Z3', '$AA$7', 'XFD1', 'A1048576']
  const ranges = ['A1:B2', '$A1:B$10', 'A:A', '$A:$A', '1:3', '$1:$3', 'B2:D40', 'A1:XFD1', 'A1:A1048576', 'C3:C9']
  const sheets = ['', 'Sheet1!', "'My Sheet'!", 'sheet1!']
  const unary = ['', '-', '+']
  const suffix = ['', '%']
  const formulas = new Set<string>()

  // Deterministic sweep over the shapes, then a seeded fill to 300.
  for (const cell of cells) for (const sheet of sheets) formulas.add(`=${sheet}${cell}`)
  for (const range of ranges) for (const sheet of sheets) formulas.add(`=SUM(${sheet}${range})`)
  for (const cell of cells) formulas.add(`=IF(${cell}>0,"${cell}",${cell})`)
  for (const range of ranges) formulas.add(`=COUNTA(${range})&"x"`)
  formulas.add('=SUM(A1:B2,C3)')
  formulas.add('=SUM(A1:B2)+\'My Sheet\'!C3')
  formulas.add('=VLOOKUP(A1,Sheet1!$A$1:$C$20,3,FALSE)')
  formulas.add('=XLOOKUP(A1,Sheet1!A:A,Sheet1!B:B)')
  formulas.add('=CONCATENATE(A1," ",B2," ","$A$1")')
  formulas.add('=IFERROR(A1/B1,"#REF! looks like this")')
  formulas.add('=SUMIF($A$1:$A$99,">"&C3,B1:B99)')
  formulas.add('=INDEX(A1:C9,MATCH(D1,A1:A9,0),2)')

  const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)]!
  let guard = 0
  while (formulas.size < 300 && guard++ < 20_000) {
    const shape = Math.floor(random() * 5)
    const sheet = pick(sheets)
    if (shape === 0) formulas.add(`=${pick(unary)}${sheet}${pick(cells)}${pick(suffix)}`)
    else if (shape === 1) formulas.add(`=SUM(${sheet}${pick(ranges)})*${1 + Math.floor(random() * 9)}`)
    else if (shape === 2) formulas.add(`=${sheet}${pick(cells)}+${pick(sheets)}${pick(cells)}`)
    else if (shape === 3) formulas.add(`=IF(${pick(cells)}=${pick(cells)},SUM(${pick(ranges)}),${pick(cells)})`)
    else formulas.add(`=ROUND(AVERAGE(${sheet}${pick(ranges)}),${Math.floor(random() * 4)})`)
  }
  return [...formulas]
}

describe('shiftFormula against the engine’s own paste semantics', () => {
  let binding: RawWasmForTests
  let model: RawWasmModelForTests
  let getTokens: (formula: string) => { token: unknown; start: number; end: number }[]

  before(async () => {
    binding = await rawWasm()
    getTokens = (formula) => binding.getTokens(formula)
    model = new binding.Model('fixtures', 'en', 'UTC', 'en')
    model.newSheet()
    model.renameSheet(1, 'My Sheet')
  })

  it('matches copyToClipboard + pasteFromClipboard for 300 formulas × 12 displacements', () => {
    const fixtures = buildFixtures()
    assert.equal(fixtures.length >= 300, true, `only built ${fixtures.length} fixtures`)

    const failures: string[] = []
    let compared = 0
    for (const fixture of fixtures) {
      model.setUserInput(0, BASE_ROW, BASE_COLUMN, fixture)
      // The engine's own spelling of the fixture — the only text we ever shift.
      const normalised = model.getCellContent(0, BASE_ROW, BASE_COLUMN)
      if (!isFormula(normalised)) continue
      model.setSelectedSheet(0)
      model.setSelectedCell(BASE_ROW, BASE_COLUMN)
      model.setSelectedRange(BASE_ROW, BASE_COLUMN, BASE_ROW, BASE_COLUMN)
      const clipboard = model.copyToClipboard()
      for (const [dr, dc] of DISPLACEMENTS) {
        const row = BASE_ROW + dr
        const column = BASE_COLUMN + dc
        model.setSelectedSheet(0)
        model.setSelectedCell(row, column)
        model.pasteFromClipboard(0, clipboard.range, clipboard.data, false)
        const engine = model.getCellContent(0, row, column)
        const ours = shiftFormula(normalised, { dr, dc, getTokens })
        compared++
        if (ours !== engine && failures.length < 20) {
          failures.push(`${normalised} @ (${dr},${dc}): engine ${engine}  ours ${ours}`)
        }
        // Put the cell back so the next displacement starts from a clean grid.
        model.setUserInput(0, row, column, '')
        model.setUserInput(0, BASE_ROW, BASE_COLUMN, fixture)
      }
    }
    assert.equal(compared >= 300 * DISPLACEMENTS.length, true, `only compared ${compared}`)
    assert.deepEqual(failures, [], `${failures.length} disagreement(s) with the engine`)
  })

  it('keeps absolutes, shifts relatives and leaves strings alone', () => {
    assert.equal(shiftFormula('=B5*2', { dr: -3, dc: 0, getTokens }), '=B2*2')
    assert.equal(shiftFormula('=$F$1', { dr: 9, dc: 9, getTokens }), '=$F$1')
    assert.equal(shiftFormula('=A$1+$A1', { dr: 2, dc: 2, getTokens }), '=C$1+$A3')
    assert.equal(shiftFormula('=IF(A1>0,"B5",B5)', { dr: 1, dc: 0, getTokens }), '=IF(A2>0,"B5",B6)')
    assert.equal(shiftFormula("='My Sheet'!C3", { dr: 1, dc: 1, getTokens }), "='My Sheet'!D4")
  })

  it('renders whole columns and whole rows in their short form', () => {
    assert.equal(shiftFormula('=SUM(A:A)', { dr: 100, dc: 0, getTokens }), '=SUM(A:A)')
    assert.equal(shiftFormula('=SUM(A:A)', { dr: 0, dc: 2, getTokens }), '=SUM(C:C)')
    assert.equal(shiftFormula('=SUM(1:3)', { dr: 4, dc: 0, getTokens }), '=SUM(5:7)')
    assert.equal(shiftFormula('=SUM(1:3)', { dr: 0, dc: 9, getTokens }), '=SUM(1:3)')
    assert.equal(shiftFormula('=SUM($A:$A)', { dr: 0, dc: 5, getTokens }), '=SUM($A:$A)')
  })

  it('fails a range’s endpoints independently and drops the sheet prefix with the left one', () => {
    assert.equal(shiftFormula('=SUM(Sheet1!A1:B2)', { dr: -1, dc: 0, getTokens }), `=SUM(${REF_ERROR}:B1)`)
    assert.equal(shiftFormula('=SUM(Sheet1!A1:XFD1)', { dr: 0, dc: 1, getTokens }), `=SUM(Sheet1!B1:${REF_ERROR})`)
    assert.equal(shiftFormula('=Sheet1!A1', { dr: -1, dc: 0, getTokens }), `=${REF_ERROR}`)
  })

  it('does not bound rows from above, only columns', () => {
    assert.equal(shiftFormula('=A1048576', { dr: 1, dc: 0, getTokens }), '=A1048577')
    assert.equal(shiftFormula('=XFD1', { dr: 0, dc: 1, getTokens }), `=${REF_ERROR}`)
  })

  it('carries the $ with the coordinate when shifted corners cross', () => {
    assert.equal(shiftFormula('=SUM($A1:B$10)', { dr: 10, dc: 0, getTokens }), '=SUM($A$10:B11)')
  })

  it('leaves non-formulas and unparseable text untouched', () => {
    assert.equal(shiftFormula('B5', { dr: 5, dc: 5, getTokens }), 'B5')
    assert.equal(shiftFormula('', { dr: 5, dc: 5, getTokens }), '')
    assert.equal(shiftFormula('=SUM(', { dr: 5, dc: 5, getTokens }), '=SUM(')
  })

  it('turns a reference into #REF! when its sheet is gone, but only when asked', () => {
    assert.equal(shiftFormula('=Ghost!A1', { dr: 0, dc: 0, getTokens }), '=Ghost!A1')
    assert.equal(shiftFormula('=Ghost!A1', { dr: 0, dc: 0, getTokens, sheetNames: ['Sheet1'] }), `=${REF_ERROR}`)
    assert.equal(shiftFormula('=sheet1!A1', { dr: 0, dc: 0, getTokens, sheetNames: ['Sheet1'] }), '=sheet1!A1')
  })

  it('reports whether a formula is well formed', () => {
    assert.equal(formulaParses('=SUM(A1:B2)', { getTokens }), true)
    assert.equal(formulaParses('=IF(A1>0,"yes","no")', { getTokens }), true)
    // The lexer's own verdict: an unterminated string is an Illegal token.
    assert.equal(formulaParses('="unterminated', { getTokens }), false)
    // getTokens is a lexer, so these two need the structural check on top.
    assert.equal(formulaParses('=SUM(', { getTokens }), false)
    assert.equal(formulaParses('=SUM(A1:B2))', { getTokens }), false)
    assert.equal(formulaParses('=1+', { getTokens }), false)
    assert.equal(tokenizeFormula('=A1', { getTokens }).length > 0, true)
  })
})
