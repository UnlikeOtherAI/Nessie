import type { LedgerAttribution } from '@nessie/runtime'
import {
  SPREADSHEET_LIMITS,
  formatA1Range,
  selectionCellCount,
  type SpreadsheetSelection,
} from '@nessie/schemas'
import {
  runPaused,
  summaryOf,
  type SpreadsheetCellStyle,
  type SpreadsheetEngineModel,
  type StyleEdit,
} from '@nessie/spreadsheet'

import { applySpreadsheetBatch, type ApplySpreadsheetBatchResult } from './apply.js'
import { invalidRequest, tooLarge } from './errors.js'
import { restructureSpreadsheet, type SpreadsheetAction } from './writes.js'
import {
  resolveRangeArgument,
  resolveSheetIndexByName,
  withSpreadsheetAtHead,
  type SpreadsheetRef,
} from './agent-reads.js'
import type { SpreadsheetServiceDeps, SpreadsheetWriteActor } from './deps.js'

/**
 * The write half of the agent tool surface.
 *
 * Nothing here writes: every one of these builds the mutation and hands it to
 * `applySpreadsheetBatch` (through `restructureSpreadsheet` where the action
 * shape already exists), so the lock, the sequence number, the audit row, the
 * filter remap and — above all — the **automatic pre-write version** cannot be
 * skipped by a tool. There is no approval gate on an agent write; the version
 * is the safety net, and it is the write door that takes it.
 *
 * docs/plans/2026-09-15-spreadsheets-ironcalc/agent-tools.md
 * docs/plans/2026-09-15-spreadsheets-ironcalc/storage-and-concurrency.md
 */

export type SpreadsheetEditActor = {
  actor: SpreadsheetWriteActor
  attribution: LedgerAttribution
  /**
   * The tool call id (builtin) or the caller's `requestId` (MCP). A retried
   * call lands on the journal's `(pageId, actorId, clientOpId)` key and is
   * answered with the batch that already applied instead of applying twice.
   */
  clientOpId: string
}

/**
 * Every server-built action goes out through `restructureSpreadsheet`, which is
 * the one caller of the write door that already knows how to rebuild the
 * structural edit a filter remap needs. Exported so `agent-structure.ts` sends
 * through exactly this and not a second copy of it.
 */
export const sendSpreadsheetAction = (
  deps: SpreadsheetServiceDeps,
  ref: SpreadsheetRef,
  who: SpreadsheetEditActor,
  action: SpreadsheetAction,
  clientOpId = who.clientOpId,
): Promise<ApplySpreadsheetBatchResult> =>
  restructureSpreadsheet(deps, {
    organizationId: ref.organizationId,
    pageId: ref.pageId,
    actor: who.actor,
    attribution: who.attribution,
    clientOpId,
    action,
  })

/** The fields every write answers with, so an agent can read back what landed. */
export const outcomeOf = (result: ApplySpreadsheetBatchResult) => ({
  seq: result.headSeq,
  replayed: result.replayed,
  noop: result.noop,
  versionId: result.safetyNetVersionId,
})

// ----------------------------------------------------------------- write cells

export type WriteRangeToolInput = SpreadsheetRef & {
  sheet?: string | null
  range?: string | null
  rows: readonly (readonly (string | number | boolean | null)[])[]
  mode?: 'overwrite' | 'insertRowsBelow'
  parseValues?: boolean
}

/**
 * `parseValues: false` forces text.
 *
 * The engine decides what a string means from the string itself — `=SUM(A1:A2)`
 * is a formula, `2026-01-31` is a date, `007` is the number 7. A quote prefix
 * is how a spreadsheet says "this one is literally text", and it is the only
 * way to write a value that *looks* like a formula without the engine parsing
 * it, which is exactly what an agent pasting scraped data needs.
 */
const asLiteral = (value: string | number | boolean | null): string | number | boolean | null =>
  typeof value === 'string' && value !== '' ? `'${value}` : value

export const writeSpreadsheetRange = async (
  deps: SpreadsheetServiceDeps,
  who: SpreadsheetEditActor,
  input: WriteRangeToolInput,
): Promise<{
  sheet: string
  range: string
  written: number
  inserted: number
  outcome: ReturnType<typeof outcomeOf>
  values?: (string | null)[][]
}> => {
  const height = input.rows.length
  const width = input.rows.reduce((widest, row) => Math.max(widest, row.length), 0)
  if (height === 0 || width === 0) throw invalidRequest('`rows` must contain at least one cell')
  if (height * width > SPREADSHEET_LIMITS.maxCellsPerWrite) {
    throw tooLarge(
      `That block is ${height * width} cells; one write is limited to `
      + `${SPREADSHEET_LIMITS.maxCellsPerWrite}`,
      { cells: height * width, cap: SPREADSHEET_LIMITS.maxCellsPerWrite },
    )
  }

  const plan = await withSpreadsheetAtHead(deps, input, (workbook) => {
    const sheet = resolveSheetIndexByName(workbook.model, input.sheet)
    const anchor = resolveRangeArgument(workbook.model, sheet, input.range)
    return {
      sheet,
      name: workbook.model.sheets()[sheet]?.name ?? `Sheet${sheet + 1}`,
      anchor: { row: anchor.r0, column: anchor.c0 },
    }
  })

  // `insertRowsBelow` is two journal batches on purpose, not one: the insert is
  // structural and the write is not, and the write door's filter remap and the
  // crossing-client conflict check both key off that distinction. Two client op
  // ids because one would make the second batch look like a replay of the first.
  let inserted = 0
  if (input.mode === 'insertRowsBelow') {
    const shift = await sendSpreadsheetAction(
      deps,
      input,
      who,
      {
        op: 'axis',
        action: {
          kind: 'insertRows',
          sheet: plan.sheet,
          row: plan.anchor.row,
          count: height,
        },
      },
      `${who.clientOpId}:insert`,
    )
    inserted = shift.noop ? 0 : height
  }

  const rows = input.parseValues === false
    ? input.rows.map((row) => row.map(asLiteral))
    : input.rows
  const result = await sendSpreadsheetAction(deps, input, who, {
    op: 'writeRange',
    sheet: plan.sheet,
    anchor: plan.anchor,
    rows,
  })

  const range: SpreadsheetSelection = {
    r0: plan.anchor.row,
    c0: plan.anchor.column,
    r1: plan.anchor.row + height - 1,
    c1: plan.anchor.column + width - 1,
  }

  // Small blocks are read back so a formula an agent wrote is answered with the
  // value it evaluated to — the single most common reason an agent would
  // otherwise call `sheet_read_range` immediately afterwards.
  const readBack = selectionCellCount(range) <= 400
    ? await withSpreadsheetAtHead(deps, input, (workbook) => {
      const values: (string | null)[][] = []
      for (let row = range.r0; row <= range.r1; row++) {
        const line: (string | null)[] = []
        for (let column = range.c0; column <= range.c1; column++) {
          line.push(workbook.model.formattedValue(plan.sheet, row, column) || '')
        }
        values.push(line)
      }
      return values
    })
    : null

  return {
    sheet: plan.name,
    range: formatA1Range(range),
    written: height * width,
    inserted,
    outcome: outcomeOf(result),
    ...(readBack ? { values: readBack } : {}),
  }
}

// ---------------------------------------------------------------------- format

export type SpreadsheetStyleInput = {
  bold?: boolean
  italic?: boolean
  underline?: boolean
  strike?: boolean
  fontColor?: string
  background?: string
  fontSize?: number
  hAlign?: 'left' | 'center' | 'right'
  vAlign?: 'top' | 'center' | 'bottom'
  wrap?: boolean
  numberFormat?: string
  borders?: 'none' | 'all' | 'outer'
}

/**
 * The style paths `updateRangeStyle` actually accepts, measured against
 * `@ironcalc/nodejs` 0.8.3. `font.sz` and `font.name` are **refused** by that
 * call (`Invalid style path`) and no `border.*` path exists at all — so font
 * size and borders are written the other way, through `setRangeStyles`, which
 * takes whole style objects and does accept both.
 */
const PATH_EDITS: { [K in keyof SpreadsheetStyleInput]?: (value: never) => StyleEdit } = {
  bold: (value: boolean) => ({ path: 'font.b', value: String(value) }),
  italic: (value: boolean) => ({ path: 'font.i', value: String(value) }),
  underline: (value: boolean) => ({ path: 'font.u', value: String(value) }),
  strike: (value: boolean) => ({ path: 'font.strike', value: String(value) }),
  fontColor: (value: string) => ({ path: 'font.color', value }),
  background: (value: string) => ({ path: 'fill.fg_color', value }),
  hAlign: (value: string) => ({ path: 'alignment.horizontal', value }),
  vAlign: (value: string) => ({ path: 'alignment.vertical', value }),
  wrap: (value: boolean) => ({ path: 'alignment.wrap_text', value: String(value) }),
  numberFormat: (value: string) => ({ path: 'num_fmt', value }),
} as never

const styleEditsOf = (style: SpreadsheetStyleInput): StyleEdit[] => {
  const edits: StyleEdit[] = []
  for (const [key, build] of Object.entries(PATH_EDITS)) {
    const value = style[key as keyof SpreadsheetStyleInput]
    if (value !== undefined) edits.push((build as (input: unknown) => StyleEdit)(value))
  }
  return edits
}

const THIN = { style: 'thin', color: '#000000' } as const

const withObjectStyle = (
  base: SpreadsheetCellStyle,
  style: SpreadsheetStyleInput,
  edge: { top: boolean; bottom: boolean; left: boolean; right: boolean },
): SpreadsheetCellStyle => {
  const next: SpreadsheetCellStyle = { ...base, font: { ...base.font } }
  if (style.fontSize !== undefined) next.font = { ...next.font, sz: style.fontSize }
  if (style.borders === 'none') next.border = {}
  if (style.borders === 'all') {
    next.border = { top: THIN, bottom: THIN, left: THIN, right: THIN }
  }
  if (style.borders === 'outer') {
    next.border = {
      ...(edge.top ? { top: THIN } : {}),
      ...(edge.bottom ? { bottom: THIN } : {}),
      ...(edge.left ? { left: THIN } : {}),
      ...(edge.right ? { right: THIN } : {}),
    }
  }
  return next
}

export const formatSpreadsheetRange = async (
  deps: SpreadsheetServiceDeps,
  who: SpreadsheetEditActor,
  input: SpreadsheetRef & {
    sheet?: string | null
    range?: string | null
    style?: SpreadsheetStyleInput
    clear?: boolean
  },
): Promise<{ sheet: string; range: string; cells: number; outcome: ReturnType<typeof outcomeOf> }> => {
  const style = input.style ?? {}
  const edits = styleEditsOf(style)
  const needsObjectStyle = style.fontSize !== undefined || style.borders !== undefined
  if (!input.clear && edits.length === 0 && !needsObjectStyle) {
    throw invalidRequest('Give at least one style property, or set `clear`')
  }

  const plan = await withSpreadsheetAtHead(deps, input, (workbook) => {
    const sheet = resolveSheetIndexByName(workbook.model, input.sheet)
    const range = resolveRangeArgument(workbook.model, sheet, input.range)
    const cells = selectionCellCount(range)
    if (cells > SPREADSHEET_LIMITS.maxCellsPerWrite) {
      throw tooLarge(`${formatA1Range(range)} is ${cells} cells, over the write limit`, {
        cells,
        cap: SPREADSHEET_LIMITS.maxCellsPerWrite,
      })
    }
    return {
      sheet,
      name: workbook.model.sheets()[sheet]?.name ?? `Sheet${sheet + 1}`,
      range,
      cells,
    }
  })

  if (input.clear) {
    const cleared = await sendSpreadsheetAction(deps, input, who, {
      op: 'clearRange',
      sheet: plan.sheet,
      range: plan.range,
      kind: 'formatting',
    })
    if (edits.length === 0 && !needsObjectStyle) {
      return {
        sheet: plan.name,
        range: formatA1Range(plan.range),
        cells: plan.cells,
        outcome: outcomeOf(cleared),
      }
    }
  }

  const result = await applySpreadsheetBatch(
    deps,
    {
      organizationId: input.organizationId,
      pageId: input.pageId,
      clientOpId: who.clientOpId,
      actor: who.actor,
      attribution: who.attribution,
      source: {
        kind: 'server',
        mutate: (model) => {
          runPaused(model, () => {
            for (const edit of edits) {
              model.updateRangeStyle(plan.sheet, plan.range, edit.path, edit.value)
            }
            if (needsObjectStyle) applyObjectStyles(model, plan.sheet, plan.range, style)
          })
          return summaryOf(null, [plan.sheet], plan.cells, [
            { sheet: plan.sheet, ...plan.range },
          ])
        },
      },
    },
    { structuralKind: null, sheetIndexes: [plan.sheet], cellCount: plan.cells, touched: [] },
  )

  return {
    sheet: plan.name,
    range: formatA1Range(plan.range),
    cells: plan.cells,
    outcome: outcomeOf(result),
  }
}

/**
 * Font size and borders, written as whole style objects.
 *
 * `setRangeStyles` refuses a partial object (`missing field 'name'`), so each
 * cell's current style is read and merged rather than invented — which also
 * means setting a border does not silently reset the font somebody chose.
 */
const applyObjectStyles = (
  model: SpreadsheetEngineModel,
  sheet: number,
  range: SpreadsheetSelection,
  style: SpreadsheetStyleInput,
): void => {
  const matrix: SpreadsheetCellStyle[][] = []
  for (let row = range.r0; row <= range.r1; row++) {
    const line: SpreadsheetCellStyle[] = []
    for (let column = range.c0; column <= range.c1; column++) {
      line.push(
        withObjectStyle(model.cellStyle(sheet, row, column), style, {
          top: row === range.r0,
          bottom: row === range.r1,
          left: column === range.c0,
          right: column === range.c1,
        }),
      )
    }
    matrix.push(line)
  }
  model.setRangeStyles(sheet, range.r0, range.c0, matrix)
}
