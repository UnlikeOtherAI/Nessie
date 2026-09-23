import type { Prisma, PrismaClient } from '@prisma/client'
import { toDeepWaterBriefRun, type DeepWaterBriefRun } from '@nessie/runtime'
import type { KeysetCursor } from '@nessie/schemas'

import { DEEP_WATER_PRODUCT_SLUG } from './deepwater-activation.js'
import { filterVisibleDeepWaterRuns, type DeepWaterResearchViewer } from './deepwater-research-access.js'

/**
 * One page of the team's DeepWater research this viewer may see, newest first
 * (Water plan nessie.md §7.1). Visibility is the run's viewer predicate
 * (`isDeepWaterRunVisible`), which needs each origin thread's live reach, so
 * rows are read in batches and filtered — and a viewer who may see few of a
 * large team's runs must not make every request read all of them. Each
 * request reads at most `batch × maxBatches` rows: when that bound is reached
 * before the page fills, the page is returned short (even empty) with
 * `hasMore` and a cursor after the last row read, so the next request carries
 * on from there and no visible row is skipped.
 */

export type DeepWaterResearchListBounds = { batch: number; maxBatches: number }

export const DEEP_WATER_RESEARCH_LIST_BOUNDS: DeepWaterResearchListBounds = { batch: 100, maxBatches: 5 }

export type DeepWaterResearchListPage = {
  runs: DeepWaterBriefRun[]
  hasMore: boolean
  /** Where the next page starts: after the last run returned, or after the last row read. */
  nextCursor: KeysetCursor | null
}

const olderThan = (cursor: KeysetCursor): Prisma.ProductIntegrationRunWhereInput => ({
  OR: [
    { createdAt: { lt: cursor.createdAt } },
    { createdAt: cursor.createdAt, id: { lt: cursor.id } },
  ],
})

export const listVisibleDeepWaterRuns = async (
  prisma: PrismaClient,
  viewer: DeepWaterResearchViewer,
  input: { teamId: string; limit: number; cursor: KeysetCursor | null },
  bounds: DeepWaterResearchListBounds = DEEP_WATER_RESEARCH_LIST_BOUNDS,
): Promise<DeepWaterResearchListPage> => {
  const found: DeepWaterBriefRun[] = []
  let after = input.cursor
  for (let read = 0; read < bounds.maxBatches; read += 1) {
    const rows = await prisma.productIntegrationRun.findMany({
      where: {
        organizationId: viewer.organizationId,
        teamId: input.teamId,
        productSlug: DEEP_WATER_PRODUCT_SLUG,
        ...(after ? olderThan(after) : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: bounds.batch,
    })
    found.push(...await filterVisibleDeepWaterRuns(prisma, viewer, rows.map(toDeepWaterBriefRun)))
    if (found.length > input.limit) {
      const runs = found.slice(0, input.limit)
      const last = runs[runs.length - 1]
      return { runs, hasMore: true, nextCursor: last ? { createdAt: last.createdAt, id: last.id } : null }
    }
    const lastRead = rows.at(-1)
    if (rows.length < bounds.batch || !lastRead) return { runs: found, hasMore: false, nextCursor: null }
    after = { createdAt: lastRead.createdAt, id: lastRead.id }
  }
  // The read bound came before the page filled: carry on after the last row read.
  return { runs: found, hasMore: true, nextCursor: after }
}
