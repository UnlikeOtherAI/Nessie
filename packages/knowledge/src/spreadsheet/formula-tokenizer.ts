import { hasFormulaTokenizer } from '@nessie/spreadsheet'
import { initFormulaTokenizer } from '@nessie/spreadsheet/node'

/**
 * Register IronCalc's own lexer in this process, once.
 *
 * Two of this build's headline behaviours are silently wrong without it, and
 * both fail **quietly** rather than loudly, which is why this exists as its own
 * module with its own call sites rather than as a line in a setup script:
 *
 * - `shiftFormula` catches a missing tokenizer and returns the formula
 *   unchanged, so a sort reorders the rows and leaves every relative reference
 *   pointing at the row it used to be on. `=B5*2` sorted from row 5 to row 2
 *   keeps reading row 5 — the numbers are wrong and nothing says so.
 * - `formulaParses` returns `false` on a missing tokenizer, so a find/replace
 *   inside formulas refuses every cell with "the replacement does not parse as
 *   a formula", which is a lie about the replacement rather than about us.
 *
 * `getTokens` is a **wasm-only** export — the Node binding does not have it —
 * so a server process that sorts or replaces has to initialise the wasm module
 * even though its workbook lives in the Node binding. It costs about 10 ms,
 * once per process, and `initFormulaTokenizer` memoises the module itself.
 *
 * docs/plans/2026-09-15-spreadsheets-ironcalc/storage-and-concurrency.md §Sort
 */

let pending: Promise<void> | null = null

export const ensureSpreadsheetFormulaTokenizer = async (): Promise<void> => {
  if (hasFormulaTokenizer()) return
  pending ??= initFormulaTokenizer().catch((error: unknown) => {
    // Let the next caller try again rather than pinning the failure for the
    // life of the process: the wasm load is a file read, and a transient
    // failure should not permanently downgrade sorting.
    pending = null
    throw error
  })
  await pending
}
