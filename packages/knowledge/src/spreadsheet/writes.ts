import { randomUUID } from 'node:crypto'

import {
  selectionCellCount,
  type SpreadsheetBatchSummary,
  type SpreadsheetIntent,
  type SpreadsheetStructuralKind,
} from '@nessie/schemas'
import {
  clearRange,
  formatRange,
  manageTabs,
  remapFilters,
  replaceInWorkbook,
  restructure,
  sortRange,
  writeRange,
  type ClearRangeInput,
  type FormatRangeInput,
  type RefusedCell,
  type ReplaceOptions,
  type ReplacedCell,
  type RestructureAction as AxisAction,
  type SortRangeInput,
  type SpreadsheetStructuralEdit,
  type TabAction,
  type WriteRangeInput,
} from '@nessie/spreadsheet'
import type { LedgerAttribution } from '@nessie/runtime'
import type { Prisma } from '@prisma/client'

import { applySpreadsheetBatch, type ApplySpreadsheetBatchResult } from './apply.js'
import { parseFilters } from './filter-model.js'
import { loadHead, lockSpreadsheetPage, modelAtHead } from './head.js'
import type { SpreadsheetServiceDeps, SpreadsheetWriteActor } from './deps.js'

/**
 * Server-built batches: the pane's structural actions, sort and replace.
 *
 * The mutations themselves are `@nessie/spreadsheet`'s — `writeRange`,
 * `clearRange`, `formatRange`, `restructure`, `manageTabs`, `sortRange`,
 * `replaceInWorkbook` — each of which pauses evaluation around its own calls,
 * returns the exact summary and leaves its diffs in the send queue. This file
 * runs them at head under the page lock and hands the queue to the write door,
 * so a server batch cannot lose a structural race: there is no `baseSeq` for
 * it to be stale against.
 */

/**
 * The discriminant is `op`, not `kind`: `ClearRangeInput` already carries its
 * own `kind` ('all' | 'contents' | 'formatting'), and two discriminants of the
 * same name on one union is a type error waiting to be resolved the wrong way.
 */
export type SpreadsheetAction =
  | ({ op: 'writeRange' } & WriteRangeInput)
  | ({ op: 'clearRange' } & ClearRangeInput)
  | ({ op: 'formatRange' } & FormatRangeInput)
  | ({ op: 'sortRange' } & SortRangeInput)
  | { op: 'axis'; action: AxisAction }
  | { op: 'tab'; action: TabAction }

const runAction = (
  model: Parameters<typeof writeRange>[0],
  action: SpreadsheetAction,
): SpreadsheetBatchSummary => {
  switch (action.op) {
    case 'writeRange': return writeRange(model, action)
    case 'clearRange': return clearRange(model, action)
    case 'formatRange': return formatRange(model, action)
    case 'sortRange': return sortRange(model, action)
    case 'axis': return restructure(model, action.action)
    case 'tab': return manageTabs(model, action.action)
  }
}

export type RestructureInput = {
  organizationId: string
  pageId: string
  actor: SpreadsheetWriteActor
  attribution: LedgerAttribution
  clientOpId?: string
  action: SpreadsheetAction
}

/**
 * The row/column intents this action is about to issue.
 *
 * Not bookkeeping — this is what lets a person keep an edit they were part-way
 * through when an agent inserted a row above it. A peer whose batch loses the
 * structural race is handed every batch since its `baseSeq` and replays its own
 * recorded intents through theirs (`shiftIntents`); a structural batch that
 * arrives with no intents says only *that* the grid moved, never *which* rows,
 * so the client reads it as "cannot be rebased" and drops the pending edit with
 * a notice. Server-built batches carried none by construction, which meant every
 * `sheet_structure` insert or delete an agent performed cost a human
 * collaborator their in-flight work.
 *
 * Only the six rebasable kinds are here. A sort reorders rows by content rather
 * than by an index delta, and a sheet add/delete/move is not a row at all —
 * neither is expressible as a shift, and claiming otherwise would land somebody's
 * edit on the wrong row, which is worse than telling them it could not be
 * carried over.
 *
 * Advisory, like the rest of the summary: it feeds the rebase, the filter remap
 * and the version decision, never an authorization one.
 */
const rebaseIntentsForAction = (action: SpreadsheetAction): SpreadsheetIntent[] => {
  if (action.op !== 'axis') return []
  const axis = action.action
  switch (axis.kind) {
    case 'insertRows':
    case 'deleteRows':
      return [{ kind: axis.kind, sheet: axis.sheet, row: axis.row, count: axis.count }]
    case 'insertColumns':
    case 'deleteColumns':
      return [{ kind: axis.kind, sheet: axis.sheet, column: axis.column, count: axis.count }]
    case 'moveRows':
    case 'moveColumns':
      return [{
        kind: axis.kind,
        sheet: axis.sheet,
        start: axis.start,
        count: axis.count,
        delta: axis.delta,
      }]
    default:
      return []
  }
}

/**
 * The **sheet-level** edits a server action performed, which no intent can
 * express.
 *
 * Adding, deleting and moving a whole sheet renumbers the sheet indexes a
 * filter model is keyed by, and `SpreadsheetIntent` has no sheet-level member —
 * so these are still rebuilt from the action and remapped after the commit. The
 * row and column edits used to be rebuilt here too; now that they ride the
 * summary as intents, the write door's own `remapFiltersForBatch` handles them,
 * and doing it in both places would shift every filter twice.
 */
const sheetEditsForAction = (
  action: SpreadsheetAction,
  sheetsBefore: number,
): SpreadsheetStructuralEdit[] => {
  if (action.op !== 'tab') return []
  const tab = action.action
  // `newSheet()` always appends, so the index a new sheet gets is the count
  // before the call — the caller never chooses it.
  if (tab.kind === 'addSheet') return [{ kind: 'addSheet', index: sheetsBefore }]
  if (tab.kind === 'deleteSheet') return [{ kind: 'deleteSheet', index: tab.sheet }]
  if (tab.kind === 'moveSheet') return [{ kind: 'moveSheet', from: tab.sheet, to: tab.toIndex }]
  return []
}

const remapFiltersForAction = async (
  deps: SpreadsheetServiceDeps,
  input: { organizationId: string; pageId: string },
  edits: SpreadsheetStructuralEdit[],
): Promise<void> => {
  if (edits.length === 0) return
  await deps.prisma.$transaction(async (tx) => {
    await lockSpreadsheetPage(tx as never, input.pageId)
    const head = await loadHead(tx as never, input.organizationId, input.pageId)
    let filters = parseFilters(head.filters)
    for (const edit of edits) filters = remapFilters(filters, edit)
    await tx.spreadsheetHead.update({
      where: { pageId: input.pageId },
      data: { filters: filters as unknown as Prisma.InputJsonValue },
    })
  })
}

const TAB_STRUCTURAL_KINDS: Record<string, SpreadsheetStructuralKind | null> = {
  addSheet: 'addSheet',
  deleteSheet: 'deleteSheet',
  renameSheet: 'renameSheet',
  moveSheet: 'moveSheet',
  hideSheet: null,
  unhideSheet: null,
}

/**
 * What this action is *about* to do, stated before it does it.
 *
 * The write door reads the summary it is handed to decide whether to take the
 * automatic pre-write version, and it reads it **before** the mutation runs —
 * which is the only moment a version of the previous state can be taken. A
 * server batch's real summary comes back out of the engine helper afterwards,
 * so handing in a blank one here meant `structuralKind` was always `null` at
 * the moment the decision was made: no delete, no sort and no sheet removal
 * ever snapshotted, on any server path. Versioning is the whole safety net for
 * writes that have no approval gate, so a blank placeholder was not a
 * harmless one.
 *
 * It stays advisory. Only the version decision, the conflict check and the
 * audit text read it, never an authorization one, and the journal still
 * records whatever the engine actually reported.
 */
const advisorySummaryForAction = (action: SpreadsheetAction): SpreadsheetBatchSummary => {
  const intents = rebaseIntentsForAction(action)
  const blank = {
    sheetIndexes: [] as number[],
    touched: [],
    ...(intents.length > 0 ? { intents } : {}),
  }
  switch (action.op) {
    case 'writeRange': {
      const height = action.rows.length
      const width = action.rows.reduce((widest, row) => Math.max(widest, row.length), 0)
      return { ...blank, structuralKind: null, sheetIndexes: [action.sheet], cellCount: height * width }
    }
    case 'clearRange':
    case 'formatRange':
      return {
        ...blank,
        structuralKind: null,
        sheetIndexes: [action.sheet],
        cellCount: selectionCellCount(action.range),
      }
    case 'sortRange':
      return {
        ...blank,
        structuralKind: 'sort',
        sheetIndexes: [action.sheet],
        cellCount: selectionCellCount(action.range),
      }
    case 'axis': {
      const kind = action.action.kind
      const structural = kind === 'insertRows' || kind === 'deleteRows'
        || kind === 'insertColumns' || kind === 'deleteColumns'
        || kind === 'moveRows' || kind === 'moveColumns'
        ? kind
        : null
      return { ...blank, structuralKind: structural, sheetIndexes: [action.action.sheet], cellCount: 0 }
    }
    case 'tab':
      return {
        ...blank,
        structuralKind: TAB_STRUCTURAL_KINDS[action.action.kind] ?? null,
        sheetIndexes: 'sheet' in action.action ? [action.action.sheet] : [],
        cellCount: 0,
      }
  }
}

export const restructureSpreadsheet = async (
  deps: SpreadsheetServiceDeps,
  input: RestructureInput,
): Promise<ApplySpreadsheetBatchResult> => {
  let edits: SpreadsheetStructuralEdit[] = []
  const intents = rebaseIntentsForAction(input.action)
  const result = await applySpreadsheetBatch(
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
          // Read before the mutation: `addSheet`'s index is the count before.
          edits = sheetEditsForAction(input.action, model.sheets().length)
          // The engine helper reports what it touched; the intents say where
          // the grid moved. Both are journalled, because the summary this
          // returns is the one a peer is handed to rebase against.
          const produced = runAction(model, input.action)
          return intents.length > 0 ? { ...produced, intents } : produced
        },
      },
    },
    advisorySummaryForAction(input.action),
  )
  if (!result.noop) await remapFiltersForAction(deps, input, edits)
  return result
}

export type SpreadsheetReplaceResult = {
  applied: number
  replaced: ReplacedCell[]
  refused: RefusedCell[]
  truncated: boolean
  batch: ApplySpreadsheetBatchResult | null
}

/**
 * Replace as one journal batch, so it undoes, broadcasts and versions like any
 * other edit. A cell whose replacement would leave a formula the engine cannot
 * parse is refused and reported by address; the rest land together.
 *
 * Planned first on the model at head purely so the caller learns whether
 * anything matched at all — the mutation that counts is the one the write door
 * performs inside its own transaction, on the model at head under the lock.
 */
export const replaceInSpreadsheet = async (
  deps: SpreadsheetServiceDeps,
  input: {
    organizationId: string
    pageId: string
    actor: SpreadsheetWriteActor
    attribution: LedgerAttribution
    clientOpId?: string
    options: ReplaceOptions
  },
): Promise<SpreadsheetReplaceResult> => {
  const preview = await deps.prisma.$transaction(async (tx) => {
    await lockSpreadsheetPage(tx as never, input.pageId)
    const head = await loadHead(tx as never, input.organizationId, input.pageId)
    const workbook = await modelAtHead(deps, tx as never, head)
    // Performed on the cached model; its diffs are discarded with the send
    // queue when the write door flushes at head. The counts are what matters.
    return replaceInWorkbook(workbook.model, input.options)
  })

  if (preview.replaced.length === 0) {
    // Nothing matched, or every match was refused: no batch, and the refusals
    // are still reported so the pane can name the cells it could not change.
    deps.cache.evict(input.pageId)
    return {
      applied: 0,
      replaced: [],
      refused: preview.refused,
      truncated: preview.truncated,
      batch: null,
    }
  }
  // The preview mutated the cached model without journalling it. Drop it so
  // the write door rebuilds from the hot snapshot and the journal — the cache
  // must never hold a state no batch describes.
  deps.cache.evict(input.pageId)

  let outcome = preview
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
          outcome = replaceInWorkbook(model, input.options)
          return outcome.summary
        },
      },
    },
    preview.summary,
  )

  return {
    applied: outcome.replaced.length,
    replaced: outcome.replaced,
    refused: outcome.refused,
    truncated: outcome.truncated,
    batch,
  }
}
