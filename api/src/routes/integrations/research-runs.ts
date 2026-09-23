import type { FastifyInstance } from 'fastify'
import {
  DeepWaterBriefViewSchema,
  DeepWaterResearchRunListSchema,
  DeepWaterResearchRunViewSchema,
  PaginationParamsSchema,
  decodeKeysetCursor,
  encodeKeysetCursor,
  resolvePageLimit,
} from '@nessie/schemas'

import { createApiResponse, parseInput, sendApiError } from '../../lib/api.js'
import {
  loadVisibleDeepWaterRun,
  resolveDeepWaterResearchViewer,
  toDeepWaterBriefViewFor,
  toDeepWaterResearchRunViews,
} from '../../services/deepwater-research-access.js'
import { listVisibleDeepWaterRuns } from '../../services/deepwater-research-list.js'
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
 * research list (`listVisibleDeepWaterRuns`, a bounded read per request), one
 * research, and its brief. Every row goes through the run's viewer predicate;
 * a run the viewer may not see answers 404, exactly like one that does not
 * exist. The mutations are in `research-run-actions.ts`.
 */

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
    const page = await listVisibleDeepWaterRuns(prisma, viewer, { teamId, limit, cursor })
    return createApiResponse(DeepWaterResearchRunListSchema.parse({
      items: await toDeepWaterResearchRunViews(prisma, viewer, page.runs),
      meta: {
        hasMore: page.hasMore,
        nextCursor: page.nextCursor ? encodeKeysetCursor(page.nextCursor) : null,
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
