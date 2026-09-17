import { createNodeModel, initFormulaTokenizer, loadWasmModelForTests } from '../../src/node.js'
import type { SpreadsheetEngineModel } from '../../src/engine.js'

// Shared test rig. Not a `*.test.ts`, so `pnpm lint:test-globs` does not expect
// the package's `node --test` glob to run it.

/** The raw wasm binding, initialised once — the tests need `Model` directly for
 *  `copyToClipboard`/`pasteFromClipboard`, which the narrow interface omits. */
export interface RawWasmForTests {
  getTokens: (formula: string) => { token: unknown; start: number; end: number }[]
  Model: new (name: string, locale: string, timezone: string, language: string) => RawWasmModelForTests
}

export interface RawWasmModelForTests {
  setUserInput(sheet: number, row: number, column: number, value: string): void
  getCellContent(sheet: number, row: number, column: number): string
  newSheet(): void
  renameSheet(sheet: number, name: string): void
  evaluate(): void
  setSelectedSheet(sheet: number): void
  setSelectedCell(row: number, column: number): void
  setSelectedRange(r0: number, c0: number, r1: number, c1: number): void
  copyToClipboard(): { range: [number, number, number, number]; data: unknown }
  pasteFromClipboard(
    sourceSheet: number,
    sourceRange: [number, number, number, number],
    clipboard: unknown,
    isCut: boolean,
  ): void
}

let raw: RawWasmForTests | null = null

export async function rawWasm(): Promise<RawWasmForTests> {
  if (raw) return raw
  // loadWasmModelForTests runs initSync as a side effect; after it the module's
  // free functions are callable.
  await loadWasmModelForTests('init')
  await initFormulaTokenizer()
  raw = (await import('@ironcalc/wasm')) as unknown as RawWasmForTests
  return raw
}

export async function tokens(): Promise<(formula: string) => { token: unknown; start: number; end: number }[]> {
  const binding = await rawWasm()
  return (formula) => binding.getTokens(formula)
}

/** A Node-binding workbook with the tokenizer registered. */
export async function nodeModel(name = 'test'): Promise<SpreadsheetEngineModel> {
  await rawWasm()
  return createNodeModel(name)
}

export function fillGrid(
  model: SpreadsheetEngineModel,
  sheet: number,
  rows: readonly (readonly (string | number)[])[],
  anchor = { row: 1, column: 1 },
): void {
  model.pauseEvaluation()
  rows.forEach((row, r) =>
    row.forEach((value, c) => model.setUserInput(sheet, anchor.row + r, anchor.column + c, String(value))),
  )
  model.resumeEvaluation()
  model.evaluate()
}

export function readGrid(
  model: SpreadsheetEngineModel,
  sheet: number,
  r0: number,
  c0: number,
  r1: number,
  c1: number,
  what: 'content' | 'value' = 'value',
): string[][] {
  const out: string[][] = []
  for (let row = r0; row <= r1; row++) {
    const line: string[] = []
    for (let column = c0; column <= c1; column++) {
      line.push(what === 'content' ? model.cellContent(sheet, row, column) : model.formattedValue(sheet, row, column))
    }
    out.push(line)
  }
  return out
}

/** A tiny deterministic PRNG so a seeded loop is reproducible from its seed. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
