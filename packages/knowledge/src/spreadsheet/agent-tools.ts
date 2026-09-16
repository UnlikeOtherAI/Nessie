import type { LedgerAttribution } from '@nessie/runtime'
import { SPREADSHEET_LIMITS } from '@nessie/schemas'

import { SpreadsheetEngineError, SpreadsheetServiceError, invalidRequest } from './errors.js'
import { replaceInSpreadsheet } from './writes.js'
import { createSpreadsheetPage } from './create.js'
import {
  describeSpreadsheet,
  findScopeOf,
  findSpreadsheetMatches,
  readSpreadsheetGrid,
  resolveSheetIndexByName,
  withSpreadsheetAtHead,
  type SpreadsheetValueMode,
} from './agent-reads.js'
import {
  formatSpreadsheetRange,
  writeSpreadsheetRange,
  type SpreadsheetEditActor,
} from './agent-edits.js'
import { manageSpreadsheetTabs, structureSpreadsheet } from './agent-structure.js'
import { runSpreadsheetFilterTool } from './agent-filters.js'
import {
  listSpreadsheetVersions,
  restoreSpreadsheetVersionForTool,
  saveSpreadsheetVersion,
} from './agent-versions.js'
import type { KnowledgePageRecord } from '../types.js'
import type { SpreadsheetServiceDeps, SpreadsheetWriteActor } from './deps.js'

/**
 * One implementation of the twelve `sheet_*` tools, called by both stacks.
 *
 * The builtin handlers in the worker and the `nessie_sheet_*` mirror on the MCP
 * server differ in exactly three things — who the actor is, how access is
 * decided, and where the answer goes — and in nothing else. Writing the tool
 * bodies twice would have made "the MCP mirror is 1:1" a promise kept by
 * review rather than by construction; the first argument coercion that drifted
 * would have made one stack silently able to do something the other could not.
 *
 * **Access is never decided here.** The caller settles it from the actor
 * context and the page's space *before* calling, and nothing in this file
 * reads a batch summary — which is what keeps the advisory summary advisory
 * (`storage-and-concurrency.md` §"The write door", owner decision 2).
 *
 * docs/plans/2026-09-15-spreadsheets-ironcalc/agent-tools.md
 */

export const SHEET_TOOL_IDS = [
  'sheet_describe',
  'sheet_read_range',
  'sheet_find',
  'sheet_replace',
  'sheet_write_range',
  'sheet_format_range',
  'sheet_structure',
  'sheet_filter',
  'sheet_tabs',
  'sheet_create',
  'sheet_export',
  'sheet_versions',
] as const
export type SheetToolId = (typeof SHEET_TOOL_IDS)[number]

/** The tools that only read; everything else goes through the write door. */
export const SHEET_READ_TOOL_IDS: ReadonlySet<string> = new Set([
  'sheet_describe',
  'sheet_read_range',
  'sheet_find',
  'sheet_export',
])

export type SheetToolContext = {
  organizationId: string
  pageId: string
  actor: SpreadsheetWriteActor
  attribution: LedgerAttribution
  /** `toolCallId` for a builtin, the caller's `requestId` for MCP. */
  clientOpId: string
}

const str = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value : undefined
const num = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined
const bool = (value: unknown): boolean | undefined =>
  typeof value === 'boolean' ? value : undefined

const valueMode = (value: unknown): SpreadsheetValueMode =>
  value === 'raw' || value === 'formula' ? value : 'display'

const stringList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []

const cellRows = (value: unknown): (string | number | boolean | null)[][] => {
  if (!Array.isArray(value)) throw invalidRequest('`rows` must be an array of rows')
  return value.map((row) => {
    if (!Array.isArray(row)) throw invalidRequest('every entry of `rows` must itself be an array')
    return row.map((cell) =>
      cell === null || cell === undefined
        ? null
        : typeof cell === 'string' || typeof cell === 'number' || typeof cell === 'boolean'
          ? cell
          : String(cell))
  })
}

/**
 * A refusal an agent can act on, rather than a stack trace it will retry into a
 * loop. The service's own vocabulary already carries the count, the cap and the
 * sheet names; everything else is a real fault and is re-thrown for the host's
 * error handling.
 */
export const toSheetToolRefusal = (error: unknown): Record<string, unknown> | null => {
  if (error instanceof SpreadsheetServiceError) {
    return {
      error: error.message,
      code: error.code,
      ...error.details,
      ...(error.code === 'SPREADSHEET_ENGINE_MISMATCH'
        ? { error: 'This spreadsheet is being upgraded; retry shortly', retryable: true }
        : {}),
    }
  }
  if (error instanceof SpreadsheetEngineError) {
    // The engine's own message, verbatim: "a workbook must keep at least one
    // sheet" is better advice than anything this layer could paraphrase.
    return { error: error.message, code: error.code }
  }
  return null
}

// ------------------------------------------------------------------- dispatch

export const runSheetPageTool = async (
  deps: SpreadsheetServiceDeps,
  context: SheetToolContext,
  toolId: SheetToolId,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> => {
  const ref = { organizationId: context.organizationId, pageId: context.pageId }
  const who: SpreadsheetEditActor = {
    actor: context.actor,
    attribution: context.attribution,
    clientOpId: context.clientOpId,
  }

  switch (toolId) {
    case 'sheet_describe':
      return describeSpreadsheet(deps, ref) as unknown as Record<string, unknown>

    case 'sheet_read_range':
      return readSpreadsheetGrid(deps, {
        ...ref,
        sheet: str(args.sheet) ?? null,
        range: str(args.range) ?? null,
        values: valueMode(args.values),
        format: args.format === 'csv' ? 'csv' : 'rows',
        includeStyles: bool(args.includeStyles) === true,
        includeHidden: bool(args.includeHidden) === true,
      }) as unknown as Record<string, unknown>

    case 'sheet_find':
      return findSpreadsheetMatches(deps, { ...ref, ...findArgs(args) }) as unknown as Record<
        string,
        unknown
      >

    case 'sheet_replace':
      return replaceForTool(deps, who, ref, args)

    case 'sheet_write_range':
      return writeSpreadsheetRange(deps, who, {
        ...ref,
        sheet: str(args.sheet) ?? null,
        range: str(args.range) ?? null,
        rows: cellRows(args.rows),
        mode: args.mode === 'insertRowsBelow' ? 'insertRowsBelow' : 'overwrite',
        parseValues: bool(args.parseValues) !== false,
      }) as unknown as Record<string, unknown>

    case 'sheet_format_range':
      return formatSpreadsheetRange(deps, who, {
        ...ref,
        sheet: str(args.sheet) ?? null,
        range: str(args.range) ?? null,
        style: (args.style ?? {}) as Parameters<typeof formatSpreadsheetRange>[2]['style'],
        clear: bool(args.clear) === true,
      }) as unknown as Record<string, unknown>

    case 'sheet_structure':
      return structureSpreadsheet(deps, who, {
        ...ref,
        sheet: str(args.sheet) ?? null,
        action: args.action as Parameters<typeof structureSpreadsheet>[2]['action'],
        range: str(args.range) ?? null,
        ...(num(args.count) === undefined ? {} : { count: num(args.count) as number }),
        ...(num(args.delta) === undefined ? {} : { delta: num(args.delta) as number }),
        ...(num(args.size) === undefined ? {} : { size: num(args.size) as number }),
        ...(args.sort
          ? {
            sort: {
              by: stringList((args.sort as { by?: unknown }).by),
              hasHeader: bool((args.sort as { hasHeader?: unknown }).hasHeader) === true,
            },
          }
          : {}),
      }) as unknown as Record<string, unknown>

    case 'sheet_filter':
      return runSpreadsheetFilterTool(deps, who, {
        ...ref,
        sheet: str(args.sheet) ?? null,
        action: (args.action ?? 'get') as 'get',
        range: str(args.range) ?? null,
        ...(args.columns
          ? { columns: args.columns as Record<string, Record<string, never>> }
          : {}),
        ...(args.sort ? { sort: args.sort as { by: string; direction?: 'asc' } } : {}),
      })

    case 'sheet_tabs':
      return manageSpreadsheetTabs(deps, who, {
        ...ref,
        action: args.action as Parameters<typeof manageSpreadsheetTabs>[2]['action'],
        name: str(args.name) ?? null,
        newName: str(args.newName) ?? null,
        ...(num(args.position) === undefined ? {} : { position: num(args.position) as number }),
      }) as unknown as Record<string, unknown>

    case 'sheet_versions':
      return versionsForTool(deps, who, ref, args)

    default:
      throw invalidRequest(`\`${String(toolId)}\` does not act on an existing spreadsheet`)
  }
}

const findArgs = (args: Record<string, unknown>) => ({
  query: String(args.query ?? ''),
  scope: (args.scope as 'workbook') ?? undefined,
  sheet: str(args.sheet) ?? null,
  range: str(args.range) ?? null,
  matchCase: bool(args.matchCase) === true,
  wholeCell: bool(args.wholeCell) === true,
  regex: bool(args.regex) === true,
  inFormulas: bool(args.inFormulas) === true,
  ...(num(args.limit) === undefined ? {} : { limit: num(args.limit) as number }),
})

/**
 * Replace, which defaults to **the first match only**.
 *
 * A replace-all across a workbook is the single most destructive thing in this
 * tool set and the easiest to ask for by accident, so the default changes one
 * cell and the answer lists what else matched. `all: true` is then a decision
 * taken with the list in hand — and the write door still takes a version first
 * once the change crosses the destructive threshold.
 */
const replaceForTool = async (
  deps: SpreadsheetServiceDeps,
  who: SpreadsheetEditActor,
  ref: { organizationId: string; pageId: string },
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> => {
  const find = findArgs(args)
  const all = bool(args.all) === true
  const scope = await withSpreadsheetAtHead(deps, ref, (workbook) =>
    findScopeOf(workbook.model, find))

  const result = await replaceInSpreadsheet(deps, {
    ...ref,
    actor: who.actor,
    attribution: who.attribution,
    clientOpId: who.clientOpId,
    options: {
      query: find.query,
      replacement: String(args.replacement ?? ''),
      scope,
      matchCase: find.matchCase,
      wholeCell: find.wholeCell,
      regex: find.regex,
      inFormulas: find.inFormulas,
      limit: all ? (find.limit ?? 200) : 1,
    },
  })

  // What is still there, so the agent can decide about `all` rather than guess.
  const remaining = result.applied > 0 && !all
    ? await findSpreadsheetMatches(deps, { ...ref, ...find })
    : null

  return {
    replaced: result.replaced.map((cell) => ({
      sheet: cell.sheetName,
      cell: cell.a1,
      before: cell.before,
      after: cell.after,
    })),
    refused: result.refused.map((cell) => ({
      sheet: cell.sheetName,
      cell: cell.a1,
      reason: cell.reason,
    })),
    applied: result.applied,
    all,
    ...(remaining ? { stillMatching: remaining.matches } : {}),
    seq: result.batch?.headSeq ?? null,
    versionId: result.batch?.safetyNetVersionId ?? null,
  }
}

const versionsForTool = async (
  deps: SpreadsheetServiceDeps,
  who: SpreadsheetEditActor,
  ref: { organizationId: string; pageId: string },
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> => {
  const action = args.action ?? 'list'
  if (action === 'list') {
    return listSpreadsheetVersions(deps, {
      ...ref,
      ...(num(args.limit) === undefined ? {} : { limit: num(args.limit) as number }),
    })
  }
  if (action === 'save') {
    return saveSpreadsheetVersion(deps, who, { ...ref, comment: str(args.comment) ?? null })
  }
  if (action === 'restore') {
    return restoreSpreadsheetVersionForTool(deps, who, {
      ...ref,
      versionId: str(args.versionId) ?? null,
    })
  }
  throw invalidRequest('`action` is one of list, save or restore')
}

// --------------------------------------------------------------------- create

export type CreateSheetToolInput = {
  organizationId: string
  spaceId: string
  projectId: string
  title: string
  parentPageId?: string | null
  taskId?: string | null
  sheets?: readonly { name?: string; rows?: (string | number | boolean | null)[][] }[]
}

/**
 * A new spreadsheet, optionally with its first sheets already filled.
 *
 * The initial rows are ordinary journal batches rather than a special
 * creation path, so a workbook an agent created has the same history, the same
 * versions and the same restore points as one a person typed into.
 */
export const createSpreadsheetForTool = async (
  deps: SpreadsheetServiceDeps,
  who: SpreadsheetEditActor,
  input: CreateSheetToolInput,
): Promise<{ page: KnowledgePageRecord; sheets: string[]; warnings: string[] }> => {
  const requested = input.sheets ?? []
  const cells = requested.reduce(
    (total, sheet) =>
      total + (sheet.rows ?? []).reduce((rows, row) => rows + row.length, 0),
    0,
  )
  if (cells > SPREADSHEET_LIMITS.maxCellsPerWrite) {
    throw invalidRequest(
      `That is ${cells} cells; a new spreadsheet is seeded with at most `
      + `${SPREADSHEET_LIMITS.maxCellsPerWrite}. Create it, then write the rest.`,
      { cells, cap: SPREADSHEET_LIMITS.maxCellsPerWrite },
    )
  }

  const page = await createSpreadsheetPage(deps, {
    organizationId: input.organizationId,
    spaceId: input.spaceId,
    projectId: input.projectId,
    title: input.title,
    parentPageId: input.parentPageId ?? null,
    taskId: input.taskId ?? null,
    authorId: who.actor.agentId ?? who.actor.id,
    authorType: who.actor.type,
    createdBy: who.actor.id,
  })

  const ref = { organizationId: input.organizationId, pageId: page.id }
  const warnings: string[] = []
  for (const [index, sheet] of requested.entries()) {
    const step = { ...who, clientOpId: `${who.clientOpId}:sheet${index}` }
    if (index > 0) {
      await manageSpreadsheetTabs(deps, step, {
        ...ref,
        action: 'add',
        newName: sheet.name ?? `Sheet${index + 1}`,
      })
    } else if (sheet.name) {
      await manageSpreadsheetTabs(deps, { ...step, clientOpId: `${step.clientOpId}:name` }, {
        ...ref,
        action: 'rename',
        name: null,
        newName: sheet.name,
      })
    }
    if (!sheet.rows?.length) continue
    await writeSpreadsheetRange(deps, { ...step, clientOpId: `${step.clientOpId}:rows` }, {
      ...ref,
      sheet: sheet.name ?? null,
      range: 'A1',
      rows: sheet.rows,
    })
  }

  const sheets = await withSpreadsheetAtHead(deps, ref, (workbook) =>
    workbook.model.sheets().map((sheet) => sheet.name))
  return { page, sheets, warnings }
}

export { resolveSheetIndexByName }
