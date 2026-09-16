import { randomUUID } from 'node:crypto'

import type { Prisma } from '@prisma/client'
import type { LedgerAttribution } from '@nessie/runtime'
import type { SpreadsheetBatchSummary } from '@nessie/schemas'

import { applySpreadsheetBatch, type ApplySpreadsheetBatchResult } from './apply.js'
import { invalidRequest } from './errors.js'
import { evaluateFilter, toRuns, type FilterDelta } from './filter-eval.js'
import {
  parseFilters,
  SpreadsheetFilterModelSchema,
  type SpreadsheetFilterModel,
  type SpreadsheetFilters,
} from './filter-model.js'
import { loadHead, lockSpreadsheetPage, modelAtHead } from './head.js'
import type { SpreadsheetServiceDeps, SpreadsheetWriteActor } from './deps.js'

/**
 * The filter surface: get, set-and-apply, clear, re-apply.
 *
 * Applying a filter is an ordinary journal batch of `setRowsHidden` diffs, so
 * it undoes, broadcasts and versions like any other edit. **Re-application is
 * explicit** — editing a value does not re-filter until somebody asks, which
 * is the Excel and Sheets rule and stops a row vanishing under a cursor.
 */

export type FilterActor = {
  actor: SpreadsheetWriteActor
  attribution: LedgerAttribution
}

export const getSpreadsheetFilters = async (
  deps: SpreadsheetServiceDeps,
  input: { organizationId: string; pageId: string },
): Promise<SpreadsheetFilters> => {
  const head = await loadHead(deps.prisma as never, input.organizationId, input.pageId)
  return parseFilters(head.filters)
}

type PlannedFilter = {
  delta: FilterDelta
  model: SpreadsheetFilterModel | null
  filters: SpreadsheetFilters
}

/**
 * Work out what a filter change hides and unhides, on the model at head.
 *
 * A model whose range no longer fits its sheet is dropped rather than applied:
 * it describes a grid that a structural batch has since taken away, and
 * applying it would hide rows nobody asked about.
 */
const planFilter = async (
  deps: SpreadsheetServiceDeps,
  input: { organizationId: string; pageId: string; sheet: number },
  next: SpreadsheetFilterModel | null,
): Promise<PlannedFilter & { stale: boolean }> =>
  deps.prisma.$transaction(async (tx) => {
    await lockSpreadsheetPage(tx as never, input.pageId)
    const head = await loadHead(tx as never, input.organizationId, input.pageId)
    const workbook = await modelAtHead(deps, tx as never, head)
    const filters = parseFilters(head.filters)
    const current = filters[String(input.sheet)] ?? null
    const sheets = workbook.model.sheets()
    if (input.sheet < 0 || input.sheet >= sheets.length) {
      throw invalidRequest('That sheet does not exist', { sheet: input.sheet })
    }

    if (!next) {
      // Clearing: unhide exactly the rows this model hid, and nothing else.
      return {
        delta: { hide: [], unhide: current?.hiddenRows ?? [], hiddenRows: [] },
        model: null,
        filters,
        stale: false,
      }
    }

    const [, , maxRow] = [
      ...workbook.model.dimensions(input.sheet),
    ] as [number, number, number, number]
    const stale = next.range.r0 > Math.max(maxRow, 1)
    if (stale) {
      return {
        delta: { hide: [], unhide: current?.hiddenRows ?? [], hiddenRows: [] },
        model: null,
        filters,
        stale: true,
      }
    }

    const delta = evaluateFilter(workbook.model, input.sheet, {
      ...next,
      hiddenRows: current?.hiddenRows ?? [],
    })
    return { delta, model: { ...next, hiddenRows: delta.hiddenRows }, filters, stale: false }
  })

const applyFilterDelta = async (
  deps: SpreadsheetServiceDeps,
  input: {
    organizationId: string
    pageId: string
    sheet: number
    who: FilterActor
    planned: PlannedFilter
    headSeqAfter: (seq: number) => void
  },
): Promise<ApplySpreadsheetBatchResult | null> => {
  const { delta } = input.planned
  if (delta.hide.length === 0 && delta.unhide.length === 0) return null
  const summary: SpreadsheetBatchSummary = {
    structuralKind: null,
    sheetIndexes: [input.sheet],
    cellCount: delta.hide.length + delta.unhide.length,
    touched: [],
    intents: [
      ...toRuns(delta.unhide).map((run) => ({
        kind: 'setRowsHidden' as const,
        sheet: input.sheet,
        start: run.start,
        end: run.end,
        hidden: false,
      })),
      ...toRuns(delta.hide).map((run) => ({
        kind: 'setRowsHidden' as const,
        sheet: input.sheet,
        start: run.start,
        end: run.end,
        hidden: true,
      })),
    ].slice(0, 200),
  }
  const result = await applySpreadsheetBatch(
    deps,
    {
      organizationId: input.organizationId,
      pageId: input.pageId,
      clientOpId: randomUUID(),
      actor: input.who.actor,
      attribution: input.who.attribution,
      source: {
        kind: 'server',
        mutate: (model) => {
          for (const run of toRuns(delta.unhide)) {
            model.setRowsHidden(input.sheet, run.start, run.end, false)
          }
          for (const run of toRuns(delta.hide)) {
            model.setRowsHidden(input.sheet, run.start, run.end, true)
          }
        },
      },
    },
    summary,
  )
  input.headSeqAfter(result.headSeq)
  return result
}

const persistFilters = async (
  deps: SpreadsheetServiceDeps,
  pageId: string,
  update: (filters: SpreadsheetFilters) => SpreadsheetFilters,
): Promise<SpreadsheetFilters> =>
  deps.prisma.$transaction(async (tx) => {
    await lockSpreadsheetPage(tx as never, pageId)
    const head = await tx.spreadsheetHead.findUniqueOrThrow({ where: { pageId } })
    const next = update(parseFilters(head.filters))
    await tx.spreadsheetHead.update({
      where: { pageId },
      data: { filters: next as unknown as Prisma.InputJsonValue },
    })
    return next
  })

export type SetFilterResult = {
  filters: SpreadsheetFilters
  batch: ApplySpreadsheetBatchResult | null
  /** True when the stored model no longer described the sheet and was dropped. */
  dropped: boolean
}

export const setSpreadsheetFilter = async (
  deps: SpreadsheetServiceDeps,
  input: {
    organizationId: string
    pageId: string
    sheet: number
    who: FilterActor
    model: unknown
  },
): Promise<SetFilterResult> => {
  const parsed = SpreadsheetFilterModelSchema.safeParse(input.model)
  if (!parsed.success) {
    throw invalidRequest('That filter could not be read', { issues: parsed.error.issues })
  }
  return applyFilterModel(deps, { ...input, next: parsed.data })
}

export const clearSpreadsheetFilter = async (
  deps: SpreadsheetServiceDeps,
  input: { organizationId: string; pageId: string; sheet: number; who: FilterActor },
): Promise<SetFilterResult> => applyFilterModel(deps, { ...input, next: null })

export const reapplySpreadsheetFilter = async (
  deps: SpreadsheetServiceDeps,
  input: { organizationId: string; pageId: string; sheet: number; who: FilterActor },
): Promise<SetFilterResult> => {
  const filters = await getSpreadsheetFilters(deps, input)
  const current = filters[String(input.sheet)]
  if (!current) throw invalidRequest('That sheet has no filter', { sheet: input.sheet })
  return applyFilterModel(deps, { ...input, next: current })
}

const applyFilterModel = async (
  deps: SpreadsheetServiceDeps,
  input: {
    organizationId: string
    pageId: string
    sheet: number
    who: FilterActor
    next: SpreadsheetFilterModel | null
  },
): Promise<SetFilterResult> => {
  const planned = await planFilter(deps, input, input.next)
  let appliedSeq = 0
  const batch = await applyFilterDelta(deps, {
    organizationId: input.organizationId,
    pageId: input.pageId,
    sheet: input.sheet,
    who: input.who,
    planned,
    headSeqAfter: (seq) => {
      appliedSeq = seq
    },
  })

  const filters = await persistFilters(deps, input.pageId, (current) => {
    const next = { ...current }
    if (planned.model) next[String(input.sheet)] = { ...planned.model, appliedAtSeq: appliedSeq }
    else delete next[String(input.sheet)]
    return next
  })

  if (planned.stale && deps.writeAudit) {
    // A dropped model is a fact about the person's document, not a silent
    // repair: the audit row is where "your filter stopped existing" is said.
    await deps.prisma.$transaction(async (tx) => {
      const page = await tx.knowledgePage.findUniqueOrThrow({
        where: { id: input.pageId },
        select: { projectId: true, teamId: true },
      })
      await deps.writeAudit?.(tx, {
        organizationId: input.organizationId,
        projectId: page.projectId,
        teamId: page.teamId,
        actorType: input.who.actor.type,
        actorId: input.who.actor.id,
        action: 'kb.spreadsheet.filter_dropped',
        resourceId: input.pageId,
        metadata: { sheet: input.sheet, reason: 'range outside the sheet' },
      })
    })
  }

  return { filters, batch, dropped: planned.stale }
}
