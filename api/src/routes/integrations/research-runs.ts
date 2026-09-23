import type { FastifyInstance } from 'fastify'
import type { Prisma, PrismaClient } from '@prisma/client'
import { toDeepWaterBriefRun, type DeepWaterBriefRun } from '@nessie/runtime'
import {
  DeepWaterBriefViewSchema,
  DeepWaterResearchRunListSchema,
  DeepWaterResearchRunViewSchema,
  PaginationParamsSchema,
  decodeKeysetCursor,
  encodeKeysetCursor,
  resolvePageLimit,
  type KeysetCursor,
} from '@nessie/schemas'

import { createApiResponse, parseInput, sendApiError } from '../../lib/api.js'
import {
  filterVisibleDeepWaterRuns,
  loadVisibleDeepWaterRun,
  resolveDeepWaterResearchViewer,
  toDeepWaterBriefViewFor,
  toDeepWaterResearchRunViews,
  type DeepWaterResearchViewer,
} from '../../services/deepwater-research-access.js'
import { DEEP_WATER_PRODUCT_SLUG } from '../../services/deepwater-activation.js'
import type { RouteDeps } from '../types.js'
import { registerResearchRunActionRoutes } from './research-run-actions.js'
import {
  RESEARCH_RUNS_PATH,
  ResearchRunParamsSchema,
  notFound,
  requireTeamId,
  sendBriefRefusal,
} from './research-run-support.js'

/**
 * The reads of the DeepWater brief API (Water plan nessie.md §7.1): the team's
 * research list, one research, and its brief. Every row goes through the run's
 * viewer predicate; a run the viewer may not see answers 404, exactly like one
 * that does not exist. The mutations are in `research-run-actions.ts`.
 */

/** How many rows one list query reads while filling a page: rows a viewer may not see are skipped. */
const SCAN_BATCH = 100

const olderThan = (cursor: KeysetCursor): Prisma.ProductIntegrationRunWhereInput => ({
  OR: [
    { createdAt: { lt: cursor.createdAt } },
    { createdAt: cursor.createdAt, id: { lt: cursor.id } },
  ],
})

/**
 * One page of the runs this viewer may see in the team, newest first. The
 * page is filled by scanning past the rows the viewer may not see, so `hasMore`
 * is exact; the cursor is the last row returned.
 */
const listVisibleRuns = async (
  prisma: PrismaClient,
  viewer: DeepWaterResearchViewer,
  input: { teamId: string; limit: number; cursor: KeysetCursor | null },
): Promise<{ runs: DeepWaterBriefRun[]; hasMore: boolean }> => {
  const found: DeepWaterBriefRun[] = []
  let after = input.cursor
  for (;;) {
    const rows = await prisma.productIntegrationRun.findMany({
      where: {
        organizationId: viewer.organizationId,
        teamId: input.teamId,
        productSlug: DEEP_WATER_PRODUCT_SLUG,
        ...(after ? olderThan(after) : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: SCAN_BATCH,
    })
    const runs = rows.map(toDeepWaterBriefRun)
    found.push(...await filterVisibleDeepWaterRuns(prisma, viewer, runs))
    const last = rows.at(-1)
    if (found.length > input.limit || rows.length < SCAN_BATCH || !last) break
    after = { createdAt: last.createdAt, id: last.id }
  }
  return { runs: found.slice(0, input.limit), hasMore: found.length > input.limit }
}

export const registerResearchRunRoutes = (app: FastifyInstance, deps: RouteDeps): void => {
  const { prisma, requireActorContext, requireUserActor } = deps

  app.get(RESEARCH_RUNS_PATH, async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireUserActor(actorContext, reply)) return reply
    const teamId = requireTeamId(actorContext, reply)
    if (!teamId) return reply
    const query = parseInput(PaginationParamsSchema, request.query, reply, 'query')
    if (!query) return reply
    const cursor = decodeKeysetCursor(query.cursor)
    if (query.cursor && !cursor) {
      sendApiError(reply, 400, 'VALIDATION_ERROR', 'Invalid cursor', 'cursor')
      return reply
    }

    const viewer = await resolveDeepWaterResearchViewer(prisma, actorContext)
    const limit = resolvePageLimit(query.limit)
    const page = await listVisibleRuns(prisma, viewer, { teamId, limit, cursor })
    const last = page.runs.at(-1)
    return createApiResponse(DeepWaterResearchRunListSchema.parse({
      items: await toDeepWaterResearchRunViews(prisma, viewer, page.runs),
      meta: {
        hasMore: page.hasMore,
        nextCursor: page.hasMore && last ? encodeKeysetCursor({ createdAt: last.createdAt, id: last.id }) : null,
        prevCursor: null,
      },
    }))
  })

  app.get(`${RESEARCH_RUNS_PATH}/:runId`, async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireUserActor(actorContext, reply)) return reply
    const params = ResearchRunParamsSchema.safeParse(request.params)
    if (!params.success) return sendBriefRefusal(reply, notFound())

    const viewer = await resolveDeepWaterResearchViewer(prisma, actorContext)
    const run = await loadVisibleDeepWaterRun(prisma, viewer, params.data.runId)
    if (!run) return sendBriefRefusal(reply, notFound())
    const [view] = await toDeepWaterResearchRunViews(prisma, viewer, [run])
    return createApiResponse(DeepWaterResearchRunViewSchema.parse(view))
  })

  app.get(`${RESEARCH_RUNS_PATH}/:runId/brief`, async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireUserActor(actorContext, reply)) return reply
    const params = ResearchRunParamsSchema.safeParse(request.params)
    if (!params.success) return sendBriefRefusal(reply, notFound())

    const viewer = await resolveDeepWaterResearchViewer(prisma, actorContext)
    const run = await loadVisibleDeepWaterRun(prisma, viewer, params.data.runId)
    // A launcher run (from before research briefs) has no brief to show.
    if (!run || run.scopeState === null) return sendBriefRefusal(reply, notFound())
    return createApiResponse(DeepWaterBriefViewSchema.parse(await toDeepWaterBriefViewFor(prisma, viewer, run)))
  })

  registerResearchRunActionRoutes(app, deps)
}
