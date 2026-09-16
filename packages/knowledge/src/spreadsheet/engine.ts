import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SPREADSHEET_ENGINE_VERSION } from '@nessie/schemas'
import { wrapNodeModel, type SpreadsheetEngineModel } from '@nessie/spreadsheet'

import { batchRejected, unsupportedFeature } from './errors.js'

// The server's engine access. Phase 0's `packages/spreadsheet/src/node.ts`
// already loads `@ironcalc/nodejs` and wraps it in `SpreadsheetEngineModel`;
// this module keeps the *raw* handle beside the wrapper because three things
// the write door needs — `saveToXlsx`, `fromXlsx` and `pasteCsvString` — are
// deliberately outside that narrow interface (they are Node-only, and two of
// them take file paths).
//
// Everything that touches the engine's xlsx entry points goes through
// `withTempDirectory`. That is an availability rule, not a style one:
// `saveToXlsx` into a directory that does not exist panics in Rust and the
// panic crosses the napi boundary as `fatal runtime error`, which `try`/`catch`
// never sees — one export to a bad path takes the whole replica down. See
// docs/plans/2026-09-15-spreadsheets-ironcalc/spike-b-xlsx.md.

const require = createRequire(import.meta.url)

/** The slice of `UserModel` that `SpreadsheetEngineModel` deliberately omits. */
interface RawUserModel {
  toBytes(): Uint8Array
  flushSendQueue(): Uint8Array
  applyExternalDiffs(diffs: Uint8Array): void
  pauseEvaluation(): void
  resumeEvaluation(): void
  evaluate(): void
  saveToXlsx(file: string): void
  setSelectedCell(row: number, column: number): void
  setSelectedSheet(sheet: number): void
  pasteCsvString(
    sheet: number,
    startRow: number,
    startColumn: number,
    endRow: number,
    endColumn: number,
    csv: string,
  ): void
}

interface NodeBinding {
  UserModel: {
    new (name: string, locale?: string, timezone?: string, languageId?: string): RawUserModel
    fromBytes(bytes: Uint8Array, languageId?: string): RawUserModel
    fromXlsx(
      filePath: string,
      locale?: string,
      timezone?: string,
      languageId?: string,
    ): RawUserModel
  }
}

let binding: NodeBinding | null = null

const nodeBinding = (): NodeBinding => {
  binding ??= require('@ironcalc/nodejs') as NodeBinding
  return binding
}

/**
 * A model plus the raw handle behind it. Every caller reads and writes through
 * `model`; `native` exists only for the three path- and selection-based calls
 * the shared interface cannot carry.
 */
export type SpreadsheetWorkbook = {
  readonly model: SpreadsheetEngineModel
  readonly native: RawUserModel
}

const wrap = (native: RawUserModel): SpreadsheetWorkbook => ({
  model: wrapNodeModel(native as never),
  native,
})

export const engineVersion = (): string => SPREADSHEET_ENGINE_VERSION

export const createEmptyWorkbook = (name = 'Sheet1'): SpreadsheetWorkbook =>
  wrap(new (nodeBinding().UserModel)(name, 'en', 'UTC', 'en'))

export const loadWorkbook = (bytes: Uint8Array): SpreadsheetWorkbook =>
  wrap(nodeBinding().UserModel.fromBytes(bytes, 'en'))

/**
 * Apply a foreign diff payload. Evaluation is paused around every apply and
 * run once afterwards: 200 000 diffs took 38 minutes un-paused against 164 ms
 * paused (`library-assessment.md`).
 */
export const applyDiffs = (workbook: SpreadsheetWorkbook, diffs: Uint8Array): void => {
  workbook.model.pauseEvaluation()
  try {
    workbook.model.applyExternalDiffs(diffs)
  } finally {
    workbook.model.resumeEvaluation()
  }
  workbook.model.evaluate()
}

/**
 * Run `mutate` with evaluation paused and hand back the diffs it produced.
 * This is how every server-built batch is made: the caller never sees the send
 * queue, so it cannot forget to drain it or to evaluate afterwards.
 *
 * A drained `flushSendQueue()` returns one byte (`[0]`, the empty list), never
 * zero — do not test the result for length 0.
 */
export const recordDiffs = (
  workbook: SpreadsheetWorkbook,
  mutate: (model: SpreadsheetEngineModel) => void,
): Uint8Array => {
  // Drain anything a previous caller left behind so this batch carries only
  // its own work.
  workbook.native.flushSendQueue()
  workbook.model.pauseEvaluation()
  try {
    mutate(workbook.model)
  } catch (error) {
    // The model may now hold a partial mutation; the caller evicts it.
    workbook.model.resumeEvaluation()
    throw batchRejected('', error instanceof Error ? error.message : String(error))
  }
  workbook.model.resumeEvaluation()
  workbook.model.evaluate()
  return workbook.native.flushSendQueue()
}

/**
 * A private 0700 directory whose whole contents are removed afterwards.
 *
 * `mkdtemp` satisfies every rule the binding imposes by construction: the
 * parent exists (so no Rust panic), the names inside are ours and fresh (so
 * `saveToXlsx` never meets an existing path), and two concurrent calls cannot
 * collide. The binding cleans up nothing it wrote, so `finally` does.
 */
export const withTempDirectory = <T>(run: (dir: string) => T): T => {
  const dir = mkdtempSync(join(tmpdir(), 'nessie-xlsx-'))
  try {
    return run(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** The workbook as xlsx bytes. Synchronous in the binding; see the caps in `import.ts`. */
export const exportXlsxBytes = (workbook: SpreadsheetWorkbook): Buffer =>
  withTempDirectory((dir) => {
    const file = join(dir, `${randomUUID()}.xlsx`)
    workbook.native.saveToXlsx(file)
    return readFileSync(file)
  })

/**
 * Build a workbook from xlsx bytes.
 *
 * **`fromXlsx` does not evaluate.** Every formula reads `#ERROR!` until
 * `evaluate()` runs, and an un-evaluated model exports those errors as cached
 * values — an import that skipped it would write a broken version of record.
 * The call is here, not at the call sites, so it cannot be forgotten.
 */
export const importXlsxBytes = (bytes: Buffer): SpreadsheetWorkbook =>
  withTempDirectory((dir) => {
    const file = join(dir, `${randomUUID()}.xlsx`)
    writeFileSync(file, bytes, { mode: 0o600 })
    let native: RawUserModel
    try {
      native = nodeBinding().UserModel.fromXlsx(file, 'en', 'UTC', 'en')
    } catch (error) {
      throw unsupportedFeature(
        'This workbook could not be read. Save it as .xlsx from your spreadsheet application and try again.',
        { reason: error instanceof Error ? error.message : String(error) },
      )
    }
    native.evaluate()
    return wrap(native)
  })

/**
 * Paste a rectangular block into a sheet.
 *
 * `pasteCsvString` is **tab**-separated despite its name, the area argument is
 * an anchor rather than a clamp, and the model's selected cell must be a
 * corner of that area or the call throws. All three are pinned by the spike;
 * this wrapper is the only sanctioned caller.
 */
export const pasteBlock = (
  workbook: SpreadsheetWorkbook,
  sheet: number,
  anchorRow: number,
  anchorColumn: number,
  rows: string[][],
): void => {
  if (rows.length === 0) return
  const height = rows.length
  const width = Math.max(...rows.map((row) => row.length))
  const tsv = rows
    .map((row) =>
      Array.from({ length: width }, (_, index) => row[index] ?? '')
        .map((cell) => (/[\t\n"]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell))
        .join('\t'),
    )
    .join('\n')
  workbook.native.setSelectedSheet(sheet)
  workbook.native.setSelectedCell(anchorRow, anchorColumn)
  workbook.native.pasteCsvString(
    sheet,
    anchorRow,
    anchorColumn,
    anchorRow + height - 1,
    anchorColumn + width - 1,
    tsv,
  )
}
