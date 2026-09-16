import { randomUUID } from 'node:crypto'

import {
  SPREADSHEET_LIMITS,
  type SpreadsheetBatchSummary,
  type SpreadsheetIntent,
  type SpreadsheetSelection,
} from '@nessie/schemas'
import type { SpreadsheetEngineModel } from '@nessie/spreadsheet'
import type { LedgerAttribution } from '@nessie/runtime'

import { applySpreadsheetBatch, type ApplySpreadsheetBatchResult } from './apply.js'
import { invalidRequest } from './errors.js'
import { loadHead, lockSpreadsheetPage, modelAtHead } from './head.js'
import { findInWorkbook, replacementFor, type SpreadsheetFindOptions } from './find.js'
import { rekeyFiltersForSheetChange } from './filter-model.js'
import type { SpreadsheetServiceDeps, SpreadsheetWriteActor } from './deps.js'

/**
 * Server-built batches: the pane's structural actions and replace.
 *
 * All of them go through the write door as `source: 'server'`, which performs
 * the mutation on the model *at head under the lock* and takes the diffs out
 * of the send queue. They therefore cannot lose a structural race — there is
 * no `baseSeq` for them to be stale against.
 */

export type RestructureAction =
  | { kind: 'insertRows'; sheet: number; row: number; count: number }
  | { kind: 'deleteRows'; sheet: number; row: number; count: number }
  | { kind: 'insertColumns'; sheet: number; column: number; count: number }
  | { kind: 'deleteColumns'; sheet: number; column: number; count: number }
  | { kind: 'setRowsHidden'; sheet: number; start: number; end: number; hidden: boolean }
  | { kind: 'setColumnsHidden'; sheet: number; start: number; end: number; hidden: boolean }
  | { kind: 'setRowsHeight'; sheet: number; start: number; end: number; size: number }
  | { kind: 'setColumnsWidth'; sheet: number; start: number; end: number; size: number }
  | { kind: 'setFrozenRowsCount'; sheet: number; count: number }
  | { kind: 'setFrozenColumnsCount'; sheet: number; count: number }
  | { kind: 'addSheet' }
  | { kind: 'deleteSheet'; sheet: number }
  | { kind: 'renameSheet'; sheet: number; name: string }
  | { kind: 'moveSheet'; sheet: number; toIndex: number }
  | { kind: 'clearRange'; sheet: number; range: SpreadsheetSelection; what: 'all' | 'contents' | 'formatting' }
  | { kind: 'setCells'; sheet: number; anchor: { row: number; column: number }; rows: string[][] }
  | {
      kind: 'formatRange'
      sheet: number
      range: SpreadsheetSelection
      stylePath: string
      value: string
    }

const STRUCTURAL: Partial<Record<RestructureAction['kind'], SpreadsheetBatchSummary['structuralKind']>> = {
  insertRows: 'insertRows',
  deleteRows: 'deleteRows',
  insertColumns: 'insertColumns',
  deleteColumns: 'deleteColumns',
  addSheet: 'addSheet',
  deleteSheet: 'deleteSheet',
  renameSheet: 'renameSheet',
  moveSheet: 'moveSheet',
}

const intentFor = (action: RestructureAction): SpreadsheetIntent[] => {
  switch (action.kind) {
    case 'insertRows':
    case 'deleteRows':
      return [{ kind: action.kind, sheet: action.sheet, row: action.row, count: action.count }]
    case 'insertColumns':
    case 'deleteColumns':
      return [{ kind: action.kind, sheet: action.sheet, column: action.column, count: action.count }]
    case 'setRowsHidden':
    case 'setColumnsHidden':
      return [{
        kind: action.kind,
        sheet: action.sheet,
        start: action.start,
        end: action.end,
        hidden: action.hidden,
      }]
    case 'clearRange':
      return [{
        kind: action.what === 'all'
          ? 'rangeClearAll'
          : action.what === 'contents' ? 'rangeClearContents' : 'rangeClearFormatting',
        sheet: action.sheet,
        range: action.range,
      }]
    default:
      return []
  }
}

const cellCountFor = (action: RestructureAction): number => {
  if (action.kind === 'clearRange' || action.kind === 'formatRange') {
    return (action.range.r1 - action.range.r0 + 1) * (action.range.c1 - action.range.c0 + 1)
  }
  if (action.kind === 'setCells') {
    return action.rows.reduce((total, row) => total + row.length, 0)
  }
  if (action.kind === 'insertRows' || action.kind === 'deleteRows') return action.count
  if (action.kind === 'insertColumns' || action.kind === 'deleteColumns') return action.count
  return 0
}

const runAction = (model: SpreadsheetEngineModel, action: RestructureAction): void => {
  switch (action.kind) {
    case 'insertRows': return model.insertRows(action.sheet, action.row, action.count)
    case 'deleteRows': return model.deleteRows(action.sheet, action.row, action.count)
    case 'insertColumns': return model.insertColumns(action.sheet, action.column, action.count)
    case 'deleteColumns': return model.deleteColumns(action.sheet, action.column, action.count)
    case 'setRowsHidden': return model.setRowsHidden(action.sheet, action.start, action.end, action.hidden)
    case 'setColumnsHidden':
      return model.setColumnsHidden(action.sheet, action.start, action.end, action.hidden)
    case 'setRowsHeight': return model.setRowsHeight(action.sheet, action.start, action.end, action.size)
    case 'setColumnsWidth': return model.setColumnsWidth(action.sheet, action.start, action.end, action.size)
    case 'setFrozenRowsCount': return model.setFrozenRowsCount(action.sheet, action.count)
    case 'setFrozenColumnsCount': return model.setFrozenColumnsCount(action.sheet, action.count)
    case 'addSheet': return model.newSheet()
    case 'deleteSheet': return model.deleteSheet(action.sheet)
    case 'renameSheet': return model.renameSheet(action.sheet, action.name)
    case 'moveSheet': return model.moveSheet(action.sheet, action.toIndex)
    case 'clearRange': return model.rangeClear(action.what, action.sheet, action.range)
    case 'formatRange':
      return model.updateRangeStyle(action.sheet, action.range, action.stylePath, action.value)
    case 'setCells': {
      let row = action.anchor.row
      for (const line of action.rows) {
        let column = action.anchor.column
        for (const value of line) {
          model.setUserInput(action.sheet, row, column, value)
          column += 1
        }
        row += 1
      }
      return
    }
    default: {
      const exhaustive: never = action
      throw invalidRequest('Unknown spreadsheet action', { action: exhaustive })
    }
  }
}

export const restructureSpreadsheet = async (
  deps: SpreadsheetServiceDeps,
  input: {
    organizationId: string
    pageId: string
    actor: SpreadsheetWriteActor
    attribution: LedgerAttribution
    clientOpId?: string
    action: RestructureAction
  },
): Promise<ApplySpreadsheetBatchResult> => {
  const cells = cellCountFor(input.action)
  if (cells > SPREADSHEET_LIMITS.maxCellsPerWrite) {
    throw invalidRequest(
      `That change touches ${cells} cells; the limit for one write is ${SPREADSHEET_LIMITS.maxCellsPerWrite}`,
      { cells, maxCells: SPREADSHEET_LIMITS.maxCellsPerWrite },
    )
  }
  const sheet = 'sheet' in input.action ? input.action.sheet : 0
  const summary: SpreadsheetBatchSummary = {
    structuralKind: STRUCTURAL[input.action.kind] ?? null,
    sheetIndexes: [sheet],
    cellCount: cells,
    touched:
      'range' in input.action
        ? [{ sheet, ...input.action.range }]
        : [],
    intents: intentFor(input.action),
  }

  const result = await applySpreadsheetBatch(
    deps,
    {
      organizationId: input.organizationId,
      pageId: input.pageId,
      clientOpId: input.clientOpId ?? randomUUID(),
      actor: input.actor,
      attribution: input.attribution,
      source: { kind: 'server', mutate: (model) => runAction(model, input.action) },
    },
    summary,
  )

  // Sheet insert/delete/move re-key the filter map, because its keys *are*
  // sheet indexes. The per-batch remap in the write door shifts rows and
  // columns; this is the other axis and only these three actions move it.
  if (
    input.action.kind === 'addSheet'
    || input.action.kind === 'deleteSheet'
    || input.action.kind === 'moveSheet'
  ) {
    const action = input.action
    await deps.prisma.$transaction(async (tx) => {
      await lockSpreadsheetPage(tx as never, input.pageId)
      const head = await loadHead(tx as never, input.organizationId, input.pageId)
      const change =
        action.kind === 'addSheet'
          ? { kind: 'addSheet' as const, at: head.sheetNames.length - 1 }
          : action.kind === 'deleteSheet'
            ? { kind: 'deleteSheet' as const, at: action.sheet }
            : { kind: 'moveSheet' as const, from: action.sheet, to: action.toIndex }
      await tx.spreadsheetHead.update({
        where: { pageId: input.pageId },
        data: { filters: rekeyFiltersForSheetChange(head.filters, change) },
      })
    })
  }

  return result
}

export type ReplaceResult = {
  applied: number
  refused: { a1: string; sheetName: string; reason: string }[]
  batch: ApplySpreadsheetBatchResult | null
}

/**
 * Replace as one journal batch, so it undoes and broadcasts like any other
 * edit. A cell whose replacement would break its formula is reported and
 * nothing is partially applied — the whole batch is built before it is sent.
 */
export const replaceInSpreadsheet = async (
  deps: SpreadsheetServiceDeps,
  input: {
    organizationId: string
    pageId: string
    actor: SpreadsheetWriteActor
    attribution: LedgerAttribution
    clientOpId?: string
    query: string
    replacement: string
    options?: SpreadsheetFindOptions
  },
): Promise<ReplaceResult> => {
  const options = input.options ?? {}
  const planned = await deps.prisma.$transaction(async (tx) => {
    await lockSpreadsheetPage(tx as never, input.pageId)
    const head = await loadHead(tx as never, input.organizationId, input.pageId)
    const workbook = await modelAtHead(deps, tx as never, head)
    const matches = findInWorkbook(workbook.model, input.query, options)
    const writes: { sheet: number; row: number; column: number; value: string }[] = []
    const refused: ReplaceResult['refused'] = []
    for (const match of matches) {
      const outcome = replacementFor(match, input.query, input.replacement, options)
      if ('refusedReason' in outcome) {
        refused.push({ a1: match.a1, sheetName: match.sheetName, reason: outcome.refusedReason })
        continue
      }
      writes.push({ sheet: match.sheet, row: match.row, column: match.column, value: outcome.value })
    }
    return { writes, refused, sheets: [...new Set(matches.map((match) => match.sheet))] }
  })

  if (planned.writes.length === 0) {
    return { applied: 0, refused: planned.refused, batch: null }
  }

  const summary: SpreadsheetBatchSummary = {
    structuralKind: null,
    sheetIndexes: planned.sheets,
    cellCount: planned.writes.length,
    touched: planned.writes.slice(0, 64).map((write) => ({
      sheet: write.sheet,
      r0: write.row,
      c0: write.column,
      r1: write.row,
      c1: write.column,
    })),
    intents: planned.writes.slice(0, SPREADSHEET_LIMITS.maxIntentsPerBatch).map((write) => ({
      kind: 'setUserInput' as const,
      sheet: write.sheet,
      row: write.row,
      column: write.column,
      value: write.value,
    })),
  }

  const batch = await applySpreadsheetBatch(
    deps,
    {
      organizationId: input.organizationId,
      pageId: input.pageId,
      clientOpId: input.clientOpId ?? randomUUID(),
      actor: input.actor,
      attribution: input.attribution,
      source: {
        kind: 'server',
        mutate: (model) => {
          for (const write of planned.writes) {
            model.setUserInput(write.sheet, write.row, write.column, write.value)
          }
        },
      },
    },
    summary,
  )

  return { applied: planned.writes.length, refused: planned.refused, batch }
}
