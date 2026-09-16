import {
  SPREADSHEET_LIMITS,
  columnLabelToIndex,
  selectionCellCount,
  type SpreadsheetSelection,
} from '@nessie/schemas'
import {
  runPaused,
  summaryOf,
  usedRange,
  type SpreadsheetCellStyle,
  type SortKey,
} from '@nessie/spreadsheet'

import { applySpreadsheetBatch } from './apply.js'
import { invalidRequest, tooLarge, unsupportedFeature } from './errors.js'
import type { SpreadsheetAction } from './writes.js'
import {
  outcomeOf,
  sendSpreadsheetAction,
  type SpreadsheetEditActor,
} from './agent-edits.js'
import {
  parseAxisSpan,
  resolveRangeArgument,
  resolveSheetIndexByName,
  withSpreadsheetAtHead,
  type SpreadsheetRef,
} from './agent-reads.js'
import type { SpreadsheetServiceDeps } from './deps.js'

/**
 * Structure and tabs: the shapes of a workbook an agent changes rather than
 * the values in it.
 *
 * Split from `agent-edits.ts` along the same seam the tools themselves use —
 * `sheet_structure` and `sheet_tabs` on this side, `sheet_write_range` and
 * `sheet_format_range` on the other. Both sides send through the one write
 * door, so the automatic pre-write version still fires for a delete or a sort
 * exactly as it does for a bulk overwrite.
 *
 * Two things here are refusals rather than features, and both are the engine's
 * limits rather than this layer's: merged cells and a sheet's tab colour.
 * IronCalc 0.8 has neither API on either binding (`decisions.md`), so a tool
 * that pretended otherwise would report a change nobody could see.
 */

// ------------------------------------------------------------------- structure

export type StructureAction =
  | 'insertRows' | 'insertColumns' | 'deleteRows' | 'deleteColumns'
  | 'moveRows' | 'moveColumns' | 'hide' | 'show' | 'resize'
  | 'merge' | 'unmerge' | 'freeze' | 'unfreeze' | 'sort' | 'clear'

export type StructureInput = SpreadsheetRef & {
  sheet?: string | null
  action: StructureAction
  range?: string | null
  count?: number
  delta?: number
  size?: number
  sort?: { by: readonly string[]; hasHeader?: boolean }
}

const sortKeysOf = (by: readonly string[]): SortKey[] =>
  by.map((entry) => {
    const descending = entry.startsWith('-')
    const label = (descending ? entry.slice(1) : entry).trim()
    return { column: columnLabelToIndex(label), direction: descending ? 'desc' : 'asc' }
  })

/** The axis a row/column action addresses, from `range` or from `count`. */
const axisSpanOf = (
  input: StructureInput,
  wants: 'rows' | 'columns',
  fallbackStart: number,
): { start: number; count: number } => {
  if (input.range) {
    const span = parseAxisSpan(input.range)
    if (span && span.axis === wants) return { start: span.start, count: input.count ?? span.count }
    if (span) {
      throw invalidRequest(
        `\`${input.action}\` addresses ${wants}; \`${input.range}\` names ${span.axis}`,
      )
    }
  }
  return { start: fallbackStart, count: Math.max(1, input.count ?? 1) }
}

export const structureSpreadsheet = async (
  deps: SpreadsheetServiceDeps,
  who: SpreadsheetEditActor,
  input: StructureInput,
): Promise<{ sheet: string; action: StructureAction; outcome: ReturnType<typeof outcomeOf> }> => {
  if (input.action === 'merge' || input.action === 'unmerge') {
    // Not a gap in this tool: IronCalc 0.8 has no merge API on either binding
    // and the string `merge` does not appear in the wasm binary
    // (decisions.md). Merges in an imported file survive a round trip and are
    // invisible to every caller, including this one.
    throw unsupportedFeature(
      'Merged cells are not supported by this spreadsheet engine; '
      + 'merges in an imported file are preserved but cannot be read or changed.',
    )
  }

  const plan = await withSpreadsheetAtHead(deps, input, (workbook) => {
    const sheet = resolveSheetIndexByName(workbook.model, input.sheet)
    const used = usedRange(workbook.model, sheet) ?? { r0: 1, c0: 1, r1: 1, c1: 1 }
    return {
      sheet,
      name: workbook.model.sheets()[sheet]?.name ?? `Sheet${sheet + 1}`,
      used,
      range: resolveRangeArgument(workbook.model, sheet, input.range),
    }
  })

  const action = structureActionOf(input, plan)
  const result = await sendSpreadsheetAction(deps, input, who, action)
  return { sheet: plan.name, action: input.action, outcome: outcomeOf(result) }
}

type StructurePlan = {
  sheet: number
  name: string
  used: SpreadsheetSelection
  range: SpreadsheetSelection
}

const structureActionOf = (input: StructureInput, plan: StructurePlan): SpreadsheetAction => {
  const sheet = plan.sheet
  switch (input.action) {
    case 'insertRows':
    case 'deleteRows': {
      const span = axisSpanOf(input, 'rows', plan.range.r0)
      return { op: 'axis', action: { kind: input.action, sheet, row: span.start, count: span.count } }
    }
    case 'insertColumns':
    case 'deleteColumns': {
      const span = axisSpanOf(input, 'columns', plan.range.c0)
      return {
        op: 'axis',
        action: { kind: input.action, sheet, column: span.start, count: span.count },
      }
    }
    case 'moveRows':
    case 'moveColumns': {
      const rows = input.action === 'moveRows'
      const span = axisSpanOf(input, rows ? 'rows' : 'columns', rows ? plan.range.r0 : plan.range.c0)
      if (input.delta === undefined) throw invalidRequest('`delta` says how far to move')
      return {
        op: 'axis',
        action: {
          kind: input.action,
          sheet,
          start: span.start,
          count: span.count,
          delta: input.delta,
        },
      }
    }
    case 'hide':
    case 'show': {
      const span = parseAxisSpan(input.range ?? '')
      if (!span) throw invalidRequest('`range` must name whole rows (`3:7`) or columns (`B:D`)')
      return {
        op: 'axis',
        action: {
          kind: span.axis === 'rows' ? 'setRowsHidden' : 'setColumnsHidden',
          sheet,
          start: span.start,
          end: span.start + span.count - 1,
          hidden: input.action === 'hide',
        },
      }
    }
    case 'resize': {
      const span = parseAxisSpan(input.range ?? '')
      if (!span) throw invalidRequest('`range` must name whole rows (`3:7`) or columns (`B:D`)')
      if (input.size === undefined) throw invalidRequest('`size` is the new height or width')
      return {
        op: 'axis',
        action: {
          kind: span.axis === 'rows' ? 'setRowsHeight' : 'setColumnsWidth',
          sheet,
          start: span.start,
          end: span.start + span.count - 1,
          size: input.size,
        },
      }
    }
    case 'freeze':
    case 'unfreeze': {
      const frozen = input.action === 'unfreeze' ? 0 : Math.max(0, input.count ?? 1)
      const columns = input.range ? parseAxisSpan(input.range)?.axis === 'columns' : false
      return {
        op: 'axis',
        action: {
          kind: columns ? 'setFrozenColumnsCount' : 'setFrozenRowsCount',
          sheet,
          count: frozen,
        },
      }
    }
    case 'sort': {
      if (!input.sort || input.sort.by.length === 0) {
        throw invalidRequest('`sort.by` lists the columns to order by, e.g. ["C", "-D"]')
      }
      return {
        op: 'sortRange',
        sheet,
        range: plan.range,
        keys: sortKeysOf(input.sort.by),
        hasHeader: input.sort.hasHeader === true,
      }
    }
    case 'clear':
      return { op: 'clearRange', sheet, range: plan.range, kind: 'all' }
    default:
      throw invalidRequest(`Unknown structure action: ${String(input.action)}`)
  }
}

// ------------------------------------------------------------------------ tabs

export type TabsInput = SpreadsheetRef & {
  action: 'add' | 'rename' | 'delete' | 'duplicate' | 'move' | 'hide' | 'unhide' | 'setColor'
  name?: string | null
  newName?: string | null
  position?: number
  color?: string
}

export const manageSpreadsheetTabs = async (
  deps: SpreadsheetServiceDeps,
  who: SpreadsheetEditActor,
  input: TabsInput,
): Promise<{ action: string; sheets: string[]; outcome: ReturnType<typeof outcomeOf> }> => {
  if (input.action === 'setColor') {
    // The engine reports a sheet's colour and has no way to set one: neither
    // binding exposes a setter, and inventing one in our layer would mean a
    // second place a sheet's colour lives.
    throw unsupportedFeature('This spreadsheet engine cannot change a sheet tab colour.')
  }
  if (input.action === 'duplicate') return duplicateSheet(deps, who, input)

  const target = input.action === 'add'
    ? -1
    : await withSpreadsheetAtHead(deps, input, (workbook) =>
      resolveSheetIndexByName(workbook.model, input.name))

  const result = await sendSpreadsheetAction(deps, input, who, { op: 'tab', action: tabActionOf(input, target) })
  const sheets = await withSpreadsheetAtHead(deps, input, (workbook) =>
    workbook.model.sheets().map((sheet) => sheet.name))
  return { action: input.action, sheets, outcome: outcomeOf(result) }
}

const tabActionOf = (
  input: TabsInput,
  sheet: number,
): Extract<SpreadsheetAction, { op: 'tab' }>['action'] => {
  switch (input.action) {
    case 'add':
      return input.newName || input.name
        ? { kind: 'addSheet', name: (input.newName ?? input.name) as string }
        : { kind: 'addSheet' }
    case 'rename': {
      const name = input.newName?.trim()
      if (!name) throw invalidRequest('`newName` is the sheet\'s new name')
      return { kind: 'renameSheet', sheet, name }
    }
    case 'delete':
      return { kind: 'deleteSheet', sheet }
    case 'move': {
      if (input.position === undefined) throw invalidRequest('`position` is the new tab index')
      return { kind: 'moveSheet', sheet, toIndex: input.position }
    }
    case 'hide':
      return { kind: 'hideSheet', sheet }
    default:
      return { kind: 'unhideSheet', sheet }
  }
}

/**
 * Duplicate, which the engine has no call for.
 *
 * A new sheet plus a copy of the source's used range — contents and styles —
 * inside one batch. Formula text is copied verbatim, which is Sheets'
 * behaviour: a relative reference now points at the new sheet's own cell, an
 * absolute one still points where it did.
 */
const duplicateSheet = async (
  deps: SpreadsheetServiceDeps,
  who: SpreadsheetEditActor,
  input: TabsInput,
): Promise<{ action: string; sheets: string[]; outcome: ReturnType<typeof outcomeOf> }> => {
  const copy = await withSpreadsheetAtHead(deps, input, (workbook) => {
    const source = resolveSheetIndexByName(workbook.model, input.name)
    const used = usedRange(workbook.model, source)
    if (used && selectionCellCount(used) > SPREADSHEET_LIMITS.maxCellsPerWrite) {
      throw tooLarge(
        `That sheet holds ${selectionCellCount(used)} cells, over the `
        + `${SPREADSHEET_LIMITS.maxCellsPerWrite}-cell copy limit`,
      )
    }
    return { source, used, name: workbook.model.sheets()[source]?.name ?? 'Sheet' }
  })

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
          const index = model.sheets().length
          runPaused(model, () => {
            model.newSheet()
            model.renameSheet(index, (input.newName?.trim() || `${copy.name} copy`).slice(0, 200))
            if (!copy.used) return
            const styles: SpreadsheetCellStyle[][] = []
            for (let row = copy.used.r0; row <= copy.used.r1; row++) {
              const line: SpreadsheetCellStyle[] = []
              for (let column = copy.used.c0; column <= copy.used.c1; column++) {
                model.setUserInput(
                  index,
                  row,
                  column,
                  model.cellContent(copy.source, row, column) ?? '',
                )
                line.push(model.cellStyle(copy.source, row, column))
              }
              styles.push(line)
            }
            model.setRangeStyles(index, copy.used.r0, copy.used.c0, styles)
          })
          return summaryOf(
            'addSheet',
            [index],
            copy.used ? selectionCellCount(copy.used) : 0,
            [],
          )
        },
      },
    },
    { structuralKind: 'addSheet', sheetIndexes: [], cellCount: 0, touched: [] },
  )

  const sheets = await withSpreadsheetAtHead(deps, input, (workbook) =>
    workbook.model.sheets().map((sheet) => sheet.name))
  return { action: 'duplicate', sheets, outcome: outcomeOf(result) }
}
