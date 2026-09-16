import {
  SPREADSHEET_LIMITS,
  columnIndexToLabel,
  selectionCellCount,
  type SpreadsheetAppliedBatch,
  type SpreadsheetBootstrap,
  type SpreadsheetSelection,
} from '@nessie/schemas'

import { catchUpExpired, invalidRequest } from './errors.js'
import { loadHead, lockSpreadsheetPage, modelAtHead } from './head.js'
import { parseFilters, type SpreadsheetFilters } from './filter-model.js'
import { findInWorkbook, type SpreadsheetFindOptions, type SpreadsheetMatch } from './find.js'
import {
  toAppliedBatch,
  toSpreadsheetActor,
  type SpreadsheetBatchRow,
  type SpreadsheetServiceDeps,
  type SpreadsheetWriteActor,
} from './deps.js'

/**
 * Reads.
 *
 * A read takes the page lock too, but only briefly: it loads the head, brings
 * the cached model up to that seq and reads. A concurrent writer therefore
 * only ever makes a reader see a slightly older *consistent* state, never a
 * torn one.
 */

export type BootstrapInput = {
  organizationId: string
  pageId: string
  viewer: { canWrite: boolean; actor: SpreadsheetWriteActor }
}

const displayNamesFor = async (
  deps: SpreadsheetServiceDeps,
  rows: SpreadsheetBatchRow[],
): Promise<Map<string, string>> => {
  const userIds = [...new Set(rows.filter((row) => row.actorType === 'user').map((row) => row.actorId))]
  const agentIds = [...new Set(rows.map((row) => row.agentId).filter((id): id is string => Boolean(id)))]
  const names = new Map<string, string>()
  if (userIds.length > 0) {
    const users = await deps.prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, displayName: true },
    })
    for (const user of users) names.set(user.id, user.displayName ?? 'Someone')
  }
  if (agentIds.length > 0) {
    const agents = await deps.prisma.agent.findMany({
      where: { id: { in: agentIds } },
      select: { id: true, name: true },
    })
    for (const agent of agents) names.set(agent.id, agent.name)
  }
  return names
}

export const bootstrapSpreadsheet = async (
  deps: SpreadsheetServiceDeps,
  input: BootstrapInput,
): Promise<SpreadsheetBootstrap & { filters: SpreadsheetFilters }> => {
  const page = await deps.prisma.knowledgePage.findFirst({
    where: { id: input.pageId, organizationId: input.organizationId, deletedAt: null },
    select: { id: true, title: true, revision: true },
  })
  if (!page) throw invalidRequest('Spreadsheet page not found', { pageId: input.pageId })

  const head = await loadHead(deps.prisma as never, input.organizationId, input.pageId)
  // Everything after the hot snapshot, so the client does `fromBytes` once and
  // applies a bounded tail. No server-side model is needed for a bootstrap.
  const rows = (await deps.prisma.spreadsheetOpBatch.findMany({
    where: { pageId: input.pageId, seq: { gt: head.hotSnapshotSeq } },
    orderBy: { seq: 'asc' },
  })) as unknown as SpreadsheetBatchRow[]
  const names = await displayNamesFor(deps, rows)

  return {
    pageId: page.id,
    title: page.title,
    revision: page.revision,
    engineVersion: head.engineVersion,
    headSeq: Number(head.headSeq),
    snapshot: {
      seq: Number(head.hotSnapshotSeq),
      bytes: Buffer.from(head.hotSnapshot).toString('base64'),
    },
    batches: rows.map((row) =>
      toAppliedBatch(row, {
        ...(names.get(row.agentId ?? row.actorId)
          ? { displayName: names.get(row.agentId ?? row.actorId) as string }
          : {}),
      }),
    ),
    sheets: head.sheetNames.map((name, index) => ({
      index,
      name,
      hidden: false,
      color: null,
    })),
    viewer: {
      canWrite: input.viewer.canWrite,
      actor: toSpreadsheetActor(input.viewer.actor),
    },
    filters: parseFilters(head.filters),
  }
}

/**
 * Catch-up. A client with a `seq` gap asks for everything after it; past
 * retention there is nothing to hand back and the answer is "re-bootstrap".
 */
export const listSpreadsheetBatches = async (
  deps: SpreadsheetServiceDeps,
  input: { organizationId: string; pageId: string; afterSeq: number; limit?: number },
): Promise<{ batches: SpreadsheetAppliedBatch[]; headSeq: number; hasMore: boolean }> => {
  const head = await loadHead(deps.prisma as never, input.organizationId, input.pageId)
  const oldest = await deps.prisma.spreadsheetOpBatch.findFirst({
    where: { pageId: input.pageId },
    orderBy: { seq: 'asc' },
    select: { seq: true },
  })
  // A gap the journal can no longer close: the caller asked for a seq older
  // than anything retained, so replay cannot reach its state.
  if (input.afterSeq < Number(head.hotSnapshotSeq) && oldest && Number(oldest.seq) > input.afterSeq + 1) {
    throw catchUpExpired(input.pageId, input.afterSeq)
  }
  const limit = Math.min(input.limit ?? SPREADSHEET_LIMITS.opsCatchUpPageSize, SPREADSHEET_LIMITS.opsCatchUpPageSize)
  const rows = (await deps.prisma.spreadsheetOpBatch.findMany({
    where: { pageId: input.pageId, seq: { gt: BigInt(input.afterSeq) } },
    orderBy: { seq: 'asc' },
    take: limit + 1,
  })) as unknown as SpreadsheetBatchRow[]
  const page = rows.slice(0, limit)
  const names = await displayNamesFor(deps, page)
  return {
    // Always inline here: this is HTTP, not a NOTIFY payload, and a client
    // reaching the catch-up route is precisely one that could not be sent the
    // bytes on the lane.
    batches: page.map((row) =>
      toAppliedBatch(row, {
        ...(names.get(row.agentId ?? row.actorId)
          ? { displayName: names.get(row.agentId ?? row.actorId) as string }
          : {}),
      }),
    ),
    headSeq: Number(head.headSeq),
    hasMore: rows.length > limit,
  }
}

export type RangeRead = {
  sheet: number
  sheetName: string
  a1: string
  rows: { value: string; content?: string }[][]
}

/**
 * Read a rectangle. Reads run on the model at head under the lock, then the
 * lock is released — a range read is milliseconds, so this costs a writer very
 * little and buys the reader a state no batch is half-applied to.
 */
export const readSpreadsheetRange = async (
  deps: SpreadsheetServiceDeps,
  input: {
    organizationId: string
    pageId: string
    sheet: number
    range: SpreadsheetSelection
    /** Include the raw cell content (formulas) beside the formatted value. */
    withContent?: boolean
  },
): Promise<RangeRead> => {
  const cells = selectionCellCount(input.range)
  if (cells > SPREADSHEET_LIMITS.maxCellsPerRead) {
    throw invalidRequest(
      `That range is ${cells} cells; the limit for one read is ${SPREADSHEET_LIMITS.maxCellsPerRead}`,
      { cells, maxCells: SPREADSHEET_LIMITS.maxCellsPerRead },
    )
  }
  return deps.prisma.$transaction(async (tx) => {
    await lockSpreadsheetPage(tx as never, input.pageId)
    const head = await loadHead(tx as never, input.organizationId, input.pageId)
    const workbook = await modelAtHead(deps, tx as never, head)
    const sheets = workbook.model.sheets()
    if (input.sheet < 0 || input.sheet >= sheets.length) {
      throw invalidRequest('That sheet does not exist', { sheet: input.sheet })
    }
    const rows: RangeRead['rows'] = []
    for (let row = input.range.r0; row <= input.range.r1; row++) {
      const line: RangeRead['rows'][number] = []
      for (let column = input.range.c0; column <= input.range.c1; column++) {
        line.push({
          value: workbook.model.formattedValue(input.sheet, row, column) ?? '',
          ...(input.withContent
            ? { content: workbook.model.cellContent(input.sheet, row, column) ?? '' }
            : {}),
        })
      }
      rows.push(line)
    }
    return {
      sheet: input.sheet,
      sheetName: sheets[input.sheet]?.name ?? `Sheet${input.sheet + 1}`,
      a1: `${columnIndexToLabel(input.range.c0)}${input.range.r0}:${columnIndexToLabel(input.range.c1)}${input.range.r1}`,
      rows,
    }
  })
}

export const findInSpreadsheet = async (
  deps: SpreadsheetServiceDeps,
  input: { organizationId: string; pageId: string; query: string } & SpreadsheetFindOptions,
): Promise<SpreadsheetMatch[]> =>
  deps.prisma.$transaction(async (tx) => {
    await lockSpreadsheetPage(tx as never, input.pageId)
    const head = await loadHead(tx as never, input.organizationId, input.pageId)
    const workbook = await modelAtHead(deps, tx as never, head)
    return findInWorkbook(workbook.model, input.query, input)
  })

export type { SpreadsheetMatch }
