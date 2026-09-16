import { randomUUID } from 'node:crypto'

import type { SpreadsheetBatchSummary } from '@nessie/schemas'
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
 * The structural edit a server action performed, in the terms the filter remap
 * understands.
 *
 * It has to be rebuilt here rather than read off the summary: `intents` are the
 * *browser's* record of its own calls, for replay after a structural refusal,
 * and a server-built batch carries none. The write door's per-batch remap is
 * therefore a no-op for these, and this is where a pane's filter learns that
 * its rows moved.
 */
const structuralEditsForAction = (
  action: SpreadsheetAction,
  sheetsBefore: number,
): SpreadsheetStructuralEdit[] => {
  if (action.op === 'axis') {
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
  if (action.op === 'tab') {
    const tab = action.action
    // `newSheet()` always appends, so the index a new sheet gets is the count
    // before the call — the caller never chooses it.
    if (tab.kind === 'addSheet') return [{ kind: 'addSheet', index: sheetsBefore }]
    if (tab.kind === 'deleteSheet') return [{ kind: 'deleteSheet', index: tab.sheet }]
    if (tab.kind === 'moveSheet') return [{ kind: 'moveSheet', from: tab.sheet, to: tab.toIndex }]
  }
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

export const restructureSpreadsheet = async (
  deps: SpreadsheetServiceDeps,
  input: RestructureInput,
): Promise<ApplySpreadsheetBatchResult> => {
  let edits: SpreadsheetStructuralEdit[] = []
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
          edits = structuralEditsForAction(input.action, model.sheets().length)
          return runAction(model, input.action)
        },
      },
    },
    // The advisory summary a server batch starts with: the real one is
    // whatever the engine helper reports, and the write door prefers it.
    { structuralKind: null, sheetIndexes: [], cellCount: 0, touched: [] },
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
