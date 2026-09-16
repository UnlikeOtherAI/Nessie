import {
  SPREADSHEET_LIMITS,
  columnIndexToLabel,
  columnLabelToIndex,
  formatA1Range,
  parseA1Range,
  selectionCellCount,
  type SpreadsheetSelection,
} from '@nessie/schemas'
import {
  cellA1,
  describe,
  findInWorkbook,
  usedRange,
  type FindOptions,
  type SpreadsheetCellStyle,
  type SpreadsheetEngineModel,
} from '@nessie/spreadsheet'

import { invalidRequest, tooLarge } from './errors.js'
import { loadHead, lockSpreadsheetPage, modelAtHead, type SpreadsheetHeadRow } from './head.js'
import { parseFilters } from './filter-model.js'
import type { SpreadsheetWorkbook } from './engine.js'
import type { SpreadsheetServiceDeps } from './deps.js'

/**
 * The read half of the agent tool surface.
 *
 * Everything here reads **the model at head, under the page lock**, exactly as
 * `reads.ts` does for the pane: a tool that read an older state would tell an
 * agent a cell holds something it no longer holds, and the agent's next write
 * would be built on that. The lock is held for milliseconds.
 *
 * What it adds over `readSpreadsheetRange` is the shape a tool needs and a
 * route does not: sheets addressed by **name**, ranges that may be a whole row
 * or column, three value modes, an optional parallel style matrix, and the
 * filter-aware row skipping that makes "read what I can see" mean the same
 * thing to an agent as it does to the person watching.
 *
 * docs/plans/2026-09-15-spreadsheets-ironcalc/agent-tools.md
 */

export type SpreadsheetRef = { organizationId: string; pageId: string }

/** Read the model at head under the lock, then let go of it. */
export const withSpreadsheetAtHead = async <T>(
  deps: SpreadsheetServiceDeps,
  ref: SpreadsheetRef,
  body: (workbook: SpreadsheetWorkbook, head: SpreadsheetHeadRow) => T | Promise<T>,
): Promise<T> =>
  deps.prisma.$transaction(async (tx) => {
    await lockSpreadsheetPage(tx as never, ref.pageId)
    const head = await loadHead(tx as never, ref.organizationId, ref.pageId)
    const workbook = await modelAtHead(deps, tx as never, head)
    return body(workbook, head)
  })

// ------------------------------------------------------------------ addressing

/**
 * Sheet **name** to index, case-insensitively, with the workbook's own names in
 * the refusal.
 *
 * An unknown sheet is the single most likely thing an agent gets wrong — it is
 * guessing from a title it read in chat — so the answer names every sheet there
 * is rather than saying no. Omitting the name picks the first *visible* sheet,
 * which is what a person opening the document sees.
 */
export const resolveSheetIndexByName = (
  model: SpreadsheetEngineModel,
  name?: string | null,
): number => {
  const sheets = model.sheets()
  if (name === undefined || name === null || name.trim() === '') {
    const visible = sheets.findIndex((sheet) => (sheet.state ?? 'visible') === 'visible')
    return visible === -1 ? 0 : visible
  }
  const wanted = name.trim()
  const exact = sheets.findIndex((sheet) => sheet.name === wanted)
  if (exact !== -1) return exact
  const folded = wanted.toLowerCase()
  const insensitive = sheets.findIndex((sheet) => sheet.name.toLowerCase() === folded)
  if (insensitive !== -1) return insensitive
  throw invalidRequest(`No sheet named ${JSON.stringify(wanted)}`, {
    sheets: sheets.map((sheet) => sheet.name),
  })
}

const ROW_SPAN = /^(\d{1,7}):(\d{1,7})$/
const COLUMN_SPAN = /^([A-Za-z]{1,3}):([A-Za-z]{1,3})$/

/**
 * A whole-row (`'3:7'`) or whole-column (`'B:D'`) address.
 *
 * `A1Schema` deliberately refuses both — it is the cell-range grammar the write
 * door and the pane share, and widening it would let `'3:3'` mean one thing to
 * a route and another to a tool. The axis forms exist only here, where a row
 * or column is genuinely the unit being addressed, and they are resolved
 * against the sheet before anything else sees them.
 */
export const parseAxisSpan = (
  range: string,
): { axis: 'rows' | 'columns'; start: number; count: number } | null => {
  const rows = ROW_SPAN.exec(range.trim())
  if (rows?.[1] && rows[2]) {
    const first = Number(rows[1])
    const last = Number(rows[2])
    if (first < 1 || last < 1) return null
    return { axis: 'rows', start: Math.min(first, last), count: Math.abs(last - first) + 1 }
  }
  const columns = COLUMN_SPAN.exec(range.trim())
  if (columns?.[1] && columns[2]) {
    const first = columnLabelToIndex(columns[1])
    const last = columnLabelToIndex(columns[2])
    return { axis: 'columns', start: Math.min(first, last), count: Math.abs(last - first) + 1 }
  }
  return null
}

/**
 * The rectangle a tool argument names: an A1 range, a whole row or column span
 * clipped to what the sheet actually holds, or — when omitted — the used range.
 *
 * Clipping an axis span to the used range is the difference between "read
 * column B" costing 12 cells and costing a million.
 */
export const resolveRangeArgument = (
  model: SpreadsheetEngineModel,
  sheet: number,
  range?: string | null,
): SpreadsheetSelection => {
  const used = usedRange(model, sheet) ?? { r0: 1, c0: 1, r1: 1, c1: 1 }
  if (range === undefined || range === null || range.trim() === '') return used
  const span = parseAxisSpan(range)
  if (!span) return parseA1Range(range)
  return span.axis === 'rows'
    ? { r0: span.start, r1: span.start + span.count - 1, c0: used.c0, c1: used.c1 }
    : { c0: span.start, c1: span.start + span.count - 1, r0: used.r0, r1: used.r1 }
}

// --------------------------------------------------------------------- describe

export type SpreadsheetSheetSummary = {
  index: number
  name: string
  usedRange: string | null
  rows: number
  columns: number
  frozenRows: number
  frozenColumns: number
  hidden: boolean
  filter: unknown | null
}

export type SpreadsheetDescription = {
  pageId: string
  title: string
  headSeq: number
  engineVersion: string
  lastEditedAt: string | null
  lastEditedBy: string | null
  sheets: SpreadsheetSheetSummary[]
  versions: number
  latestVersion: { id: string; number: number; comment: string | null; at: string } | null
}

/**
 * The first call an agent makes: what this workbook is, without a single cell.
 *
 * No `definedNames` and no per-sheet merge count, both of which
 * `agent-tools.md` listed. Neither binding exposes a defined-name enumerator or
 * any merge API at all (`decisions.md` — merges are struck from this plan), so
 * both fields could only ever have been fabricated.
 */
export const describeSpreadsheet = async (
  deps: SpreadsheetServiceDeps,
  ref: SpreadsheetRef,
): Promise<SpreadsheetDescription> => {
  const page = await deps.prisma.knowledgePage.findFirst({
    where: { id: ref.pageId, organizationId: ref.organizationId, deletedAt: null },
    select: { id: true, title: true },
  })
  if (!page) throw invalidRequest('Spreadsheet page not found', { pageId: ref.pageId })

  const [shape, lastBatch, versionCount, latest] = await Promise.all([
    withSpreadsheetAtHead(deps, ref, (workbook, head) => ({
      head,
      sheets: describe(workbook.model).sheets.map((sheet) => ({
        index: sheet.index,
        name: sheet.name,
        usedRange: sheet.usedRangeA1,
        rows: sheet.rowCount,
        columns: sheet.columnCount,
        frozenRows: sheet.frozenRows,
        frozenColumns: sheet.frozenColumns,
        hidden: sheet.hidden,
        filter: parseFilters(head.filters)[String(sheet.index)] ?? null,
      })),
    })),
    deps.prisma.spreadsheetOpBatch.findFirst({
      where: { pageId: ref.pageId },
      orderBy: { seq: 'desc' },
      select: { createdAt: true, actorType: true, actorId: true, agentId: true },
    }),
    deps.prisma.knowledgePageVersion.count({ where: { pageId: ref.pageId } }),
    deps.prisma.knowledgePageVersion.findFirst({
      where: { pageId: ref.pageId },
      orderBy: { versionNumber: 'desc' },
      select: { id: true, versionNumber: true, changeComment: true, createdAt: true },
    }),
  ])

  return {
    pageId: page.id,
    title: page.title,
    headSeq: Number(shape.head.headSeq),
    engineVersion: shape.head.engineVersion,
    lastEditedAt: lastBatch?.createdAt.toISOString() ?? null,
    lastEditedBy: lastBatch
      ? await displayNameOf(deps, lastBatch.actorType, lastBatch.agentId ?? lastBatch.actorId)
      : null,
    sheets: shape.sheets,
    versions: versionCount,
    latestVersion: latest
      ? {
        id: latest.id,
        number: latest.versionNumber,
        comment: latest.changeComment,
        at: latest.createdAt.toISOString(),
      }
      : null,
  }
}

const displayNameOf = async (
  deps: SpreadsheetServiceDeps,
  actorType: 'user' | 'agent',
  id: string,
): Promise<string | null> => {
  if (actorType === 'agent') {
    const agent = await deps.prisma.agent.findUnique({ where: { id }, select: { name: true } })
    return agent?.name ?? 'Agent'
  }
  const user = await deps.prisma.user.findUnique({ where: { id }, select: { displayName: true } })
  return user?.displayName ?? 'Someone'
}

// ------------------------------------------------------------------------ read

export type SpreadsheetValueMode = 'display' | 'raw' | 'formula'

export type SpreadsheetCellStyleSummary = {
  bold: boolean
  italic: boolean
  fontColor: string | null
  background: string | null
  numberFormat: string | null
}

export type SpreadsheetGridRead = {
  sheet: string
  sheetIndex: number
  range: string
  values: SpreadsheetValueMode
  rows: (string | number | boolean | null)[][]
  csv?: string
  styles?: SpreadsheetCellStyleSummary[][]
  /** Rows a filter hides that were left out; 0 when `includeHidden`. */
  hiddenRowsOmitted: number
  truncated: boolean
}

export type ReadGridInput = SpreadsheetRef & {
  sheet?: string | null
  range?: string | null
  values?: SpreadsheetValueMode
  format?: 'rows' | 'csv'
  includeStyles?: boolean
  includeHidden?: boolean
}

const styleSummary = (style: SpreadsheetCellStyle): SpreadsheetCellStyleSummary => ({
  bold: style.font?.b === true,
  italic: style.font?.i === true,
  // The engine accepts `fill.fg_color` on the way in and reports `fill.color`
  // on the way out (measured). Reading only one of them showed every
  // background as unset.
  fontColor: style.font?.color ?? null,
  background: style.fill?.fg_color ?? (style.fill as { color?: string } | undefined)?.color ?? null,
  numberFormat: style.num_fmt && style.num_fmt !== 'general' ? style.num_fmt : null,
})

const cellValue = (
  model: SpreadsheetEngineModel,
  mode: SpreadsheetValueMode,
  sheet: number,
  row: number,
  column: number,
): string | null => {
  if (mode === 'display') return model.formattedValue(sheet, row, column) || ''
  const content = model.cellContent(sheet, row, column) ?? ''
  if (mode === 'raw') return content
  return content.startsWith('=') ? content : null
}

const csvField = (value: string | number | boolean | null): string => {
  const text = value === null ? '' : String(value)
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/**
 * Read a rectangle the way a tool wants it.
 *
 * Refused rather than truncated past the cap: an agent that silently received
 * the first 10 000 cells of a 40 000-cell range would summarise a quarter of a
 * sheet and say it had read the sheet. The refusal carries the count and a
 * split that fits, so the next call is obvious.
 */
export const readSpreadsheetGrid = async (
  deps: SpreadsheetServiceDeps,
  input: ReadGridInput,
): Promise<SpreadsheetGridRead> =>
  withSpreadsheetAtHead(deps, input, (workbook) => {
    const model = workbook.model
    const sheet = resolveSheetIndexByName(model, input.sheet)
    const range = resolveRangeArgument(model, sheet, input.range)
    const cells = selectionCellCount(range)
    if (cells > SPREADSHEET_LIMITS.maxCellsPerRead) {
      const width = range.c1 - range.c0 + 1
      const perRead = Math.max(1, Math.floor(SPREADSHEET_LIMITS.maxCellsPerRead / width))
      throw tooLarge(
        `${formatA1Range(range)} is ${cells} cells; one read is limited to `
        + `${SPREADSHEET_LIMITS.maxCellsPerRead}`,
        {
          cells,
          cap: SPREADSHEET_LIMITS.maxCellsPerRead,
          suggestion:
            `read ${perRead} rows at a time, starting with `
            + `${formatA1Range({ ...range, r1: Math.min(range.r1, range.r0 + perRead - 1) })}`,
        },
      )
    }

    const mode = input.values ?? 'display'
    const rows: (string | number | boolean | null)[][] = []
    const styles: SpreadsheetCellStyleSummary[][] = []
    let hiddenRowsOmitted = 0
    for (let row = range.r0; row <= range.r1; row++) {
      if (!input.includeHidden && model.isRowHidden(sheet, row)) {
        hiddenRowsOmitted++
        continue
      }
      const line: (string | number | boolean | null)[] = []
      const styleLine: SpreadsheetCellStyleSummary[] = []
      for (let column = range.c0; column <= range.c1; column++) {
        line.push(cellValue(model, mode, sheet, row, column))
        if (input.includeStyles) styleLine.push(styleSummary(model.cellStyle(sheet, row, column)))
      }
      rows.push(line)
      if (input.includeStyles) styles.push(styleLine)
    }

    return {
      sheet: model.sheets()[sheet]?.name ?? `Sheet${sheet + 1}`,
      sheetIndex: sheet,
      range: formatA1Range(range),
      values: mode,
      rows,
      ...(input.format === 'csv'
        ? { csv: rows.map((line) => line.map(csvField).join(',')).join('\r\n') }
        : {}),
      ...(input.includeStyles ? { styles } : {}),
      hiddenRowsOmitted,
      truncated: false,
    }
  })

// ------------------------------------------------------------------------ find

export type FindMatch = {
  sheet: string
  cell: string
  value: string
  formula?: string
}

export type FindInput = SpreadsheetRef & {
  query: string
  scope?: 'sheet' | 'workbook' | 'range'
  sheet?: string | null
  range?: string | null
  matchCase?: boolean
  wholeCell?: boolean
  regex?: boolean
  inFormulas?: boolean
  limit?: number
}

const FIND_LIMIT = 200

/**
 * Build the engine-level find scope from the tool's argument shape. The sheet
 * is resolved by name here, inside the same transaction that will read, so a
 * rename between resolving and searching cannot point the search at the wrong
 * tab.
 */
export const findScopeOf = (
  model: SpreadsheetEngineModel,
  input: Pick<FindInput, 'scope' | 'sheet' | 'range'>,
): FindOptions['scope'] => {
  const scope = input.scope ?? (input.range ? 'range' : input.sheet ? 'sheet' : 'workbook')
  if (scope === 'workbook') return { kind: 'workbook' }
  const sheet = resolveSheetIndexByName(model, input.sheet)
  if (scope === 'sheet') return { kind: 'sheet', sheet }
  return { kind: 'range', sheet, range: resolveRangeArgument(model, sheet, input.range) }
}

export const findSpreadsheetMatches = async (
  deps: SpreadsheetServiceDeps,
  input: FindInput,
): Promise<{ matches: FindMatch[]; total: number; truncated: boolean; scanned: number }> =>
  withSpreadsheetAtHead(deps, input, (workbook) => {
    const model = workbook.model
    const result = findInWorkbook(model, {
      query: input.query,
      scope: findScopeOf(model, input),
      matchCase: input.matchCase === true,
      wholeCell: input.wholeCell === true,
      regex: input.regex === true,
      inFormulas: input.inFormulas === true,
      limit: Math.min(Math.max(input.limit ?? FIND_LIMIT, 1), FIND_LIMIT),
    })
    return {
      matches: result.matches.map((match) => {
        const formula = model.cellContent(match.sheet, match.row, match.column) ?? ''
        return {
          sheet: match.sheetName,
          cell: cellA1(match.row, match.column),
          value: match.text,
          ...(formula.startsWith('=') ? { formula } : {}),
        }
      }),
      total: result.matches.length,
      truncated: result.truncated,
      scanned: result.scanned,
    }
  })

export { columnIndexToLabel, columnLabelToIndex }
