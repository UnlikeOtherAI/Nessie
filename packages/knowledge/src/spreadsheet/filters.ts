import { randomUUID } from 'node:crypto'

import type { Prisma } from '@prisma/client'
import type { LedgerAttribution } from '@nessie/runtime'
import {
  SpreadsheetFilterModelSchema,
  type SpreadsheetFilterModel,
} from '@nessie/schemas'
import { applyFilter, clearFilter, type ApplyFilterResult } from '@nessie/spreadsheet'

import { applySpreadsheetBatch, type ApplySpreadsheetBatchResult } from './apply.js'
import { invalidRequest } from './errors.js'
import { parseFilters, type SpreadsheetFilters } from './filter-model.js'
import { loadHead, lockSpreadsheetPage, modelAtHead } from './head.js'
import type { SpreadsheetServiceDeps, SpreadsheetWriteActor } from './deps.js'

/**
 * The filter surface: get, set-and-apply, clear, re-apply.
 *
 * Applying a filter is an ordinary journal batch of `setRowsHidden` diffs, so
 * it undoes, broadcasts and versions like any other edit. **Re-application is
 * explicit** — editing a value does not re-filter until somebody asks, which
 * is the Excel and Sheets rule and stops a row vanishing under a cursor.
 *
 * The criteria, the hidden-row delta and the model live in
 * `@nessie/spreadsheet`; what happens here is the two-phase dance the rest of
 * this package uses everywhere: plan on the model at head to find out whether
 * anything changes, then send the change through the one write door.
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

export type SetFilterResult = {
  filters: SpreadsheetFilters
  batch: ApplySpreadsheetBatchResult | null
  /** True when the stored model no longer described the sheet and was dropped. */
  dropped: boolean
  hidden: number[]
  shown: number[]
}

type FilterChange =
  | { kind: 'set'; model: SpreadsheetFilterModel }
  | { kind: 'clear' }
  | { kind: 'reapply' }

/**
 * Decide, on the model at head, what this change does — without writing
 * anything. The engine calls `applyFilter`/`clearFilter` make are performed on
 * the cached model and their diffs are *discarded*; the real mutation is
 * replayed inside the write door's own transaction, on the model at head under
 * the lock, so the journal and the head can never disagree about what landed.
 */
const planFilterChange = async (
  deps: SpreadsheetServiceDeps,
  input: { organizationId: string; pageId: string; sheet: number },
  change: FilterChange,
): Promise<{ outcome: ApplyFilterResult | null; stale: boolean; current: SpreadsheetFilterModel | null }> =>
  deps.prisma.$transaction(async (tx) => {
    await lockSpreadsheetPage(tx as never, input.pageId)
    const head = await loadHead(tx as never, input.organizationId, input.pageId)
    const workbook = await modelAtHead(deps, tx as never, head)
    const sheets = workbook.model.sheets()
    if (input.sheet < 0 || input.sheet >= sheets.length) {
      throw invalidRequest('That sheet does not exist', { sheet: input.sheet })
    }
    const filters = parseFilters(head.filters)
    const current = filters[String(input.sheet)] ?? null

    if (change.kind === 'clear') {
      if (!current) return { outcome: null, stale: false, current: null }
      return { outcome: clearFilter(workbook.model, input.sheet, current), stale: false, current }
    }

    const wanted = change.kind === 'set' ? change.model : current
    if (!wanted) throw invalidRequest('That sheet has no filter', { sheet: input.sheet })

    // A model whose header row is past the end of the sheet describes a grid a
    // structural batch took away. Dropped with an audit note rather than
    // applied — applying it would hide rows nobody asked about.
    const [, , maxRow] = workbook.model.dimensions(input.sheet)
    if (wanted.range.r0 > Math.max(maxRow, 1)) {
      return {
        outcome: current ? clearFilter(workbook.model, input.sheet, current) : null,
        stale: true,
        current,
      }
    }

    return {
      outcome: applyFilter(
        workbook.model,
        input.sheet,
        // Carry forward the rows this filter hid, so a re-apply unhides
        // exactly those and never somebody's manual hide.
        { ...wanted, hiddenRows: current?.hiddenRows ?? wanted.hiddenRows },
        String(Number(head.headSeq) + 1),
      ),
      stale: false,
      current,
    }
  })

const sendFilterBatch = async (
  deps: SpreadsheetServiceDeps,
  input: {
    organizationId: string
    pageId: string
    sheet: number
    who: FilterActor
    outcome: ApplyFilterResult
    model: SpreadsheetFilterModel
  },
): Promise<ApplySpreadsheetBatchResult | null> => {
  const { hidden, shown } = input.outcome
  if (hidden.length === 0 && shown.length === 0) return null
  return applySpreadsheetBatch(
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
          // Replayed at head under the lock rather than reusing the planning
          // model's diffs: between planning and committing another batch may
          // have landed, and `setRowsHidden` is idempotent by row index.
          for (const [start, end] of runsOf(shown)) model.setRowsHidden(input.sheet, start, end, false)
          for (const [start, end] of runsOf(hidden)) model.setRowsHidden(input.sheet, start, end, true)
        },
      },
    },
    input.outcome.summary,
  )
}

const runsOf = (rows: number[]): [number, number][] => {
  const runs: [number, number][] = []
  for (const row of [...rows].sort((a, b) => a - b)) {
    const last = runs[runs.length - 1]
    if (last && row === last[1] + 1) last[1] = row
    else runs.push([row, row])
  }
  return runs
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

const auditDroppedFilter = async (
  deps: SpreadsheetServiceDeps,
  input: { organizationId: string; pageId: string; sheet: number; who: FilterActor },
): Promise<void> => {
  if (!deps.writeAudit) return
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
      metadata: { sheet: input.sheet, reason: 'the filtered range is no longer on the sheet' },
    })
  })
}

const changeFilter = async (
  deps: SpreadsheetServiceDeps,
  input: {
    organizationId: string
    pageId: string
    sheet: number
    who: FilterActor
    change: FilterChange
  },
): Promise<SetFilterResult> => {
  const planned = await planFilterChange(deps, input, input.change)
  const batch = planned.outcome
    ? await sendFilterBatch(deps, {
        ...input,
        outcome: planned.outcome,
        model: planned.outcome.filter,
      })
    : null

  const keep = !planned.stale && input.change.kind !== 'clear' && planned.outcome !== null
  const filters = await persistFilters(deps, input.pageId, (current) => {
    const next = { ...current }
    if (keep && planned.outcome) next[String(input.sheet)] = planned.outcome.filter
    else delete next[String(input.sheet)]
    return next
  })

  if (planned.stale) await auditDroppedFilter(deps, input)

  return {
    filters,
    batch,
    dropped: planned.stale,
    hidden: planned.outcome?.hidden ?? [],
    shown: planned.outcome?.shown ?? [],
  }
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
  return changeFilter(deps, { ...input, change: { kind: 'set', model: parsed.data } })
}

export const clearSpreadsheetFilter = (
  deps: SpreadsheetServiceDeps,
  input: { organizationId: string; pageId: string; sheet: number; who: FilterActor },
): Promise<SetFilterResult> => changeFilter(deps, { ...input, change: { kind: 'clear' } })

export const reapplySpreadsheetFilter = (
  deps: SpreadsheetServiceDeps,
  input: { organizationId: string; pageId: string; sheet: number; who: FilterActor },
): Promise<SetFilterResult> => changeFilter(deps, { ...input, change: { kind: 'reapply' } })
