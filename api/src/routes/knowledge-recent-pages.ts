import type { FastifyInstance } from 'fastify'
import { KnowledgeRecentPagesQuerySchema } from '../contracts/knowledge-base.js'
import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import {
  createKnowledgeAccess,
  requireKnowledgePolicy,
  type KnowledgeRouteDeps,
} from './knowledge-base-access.js'

// "What was last written down in this project" — the recency list the project
// dashboard's Documents section renders. Split out from knowledge-base.ts
// (already at the 500-line file cap), mirroring knowledge-links.ts.
//
// It is a read of pages, not a search: the provider orders by updatedAt over
// the (organization_id, project_id, updated_at desc, id desc) index and applies
// the one space-read rule (readableSpaceIdsSqlForViewer, mirroring
// canReadSpace) — the same enforcement GET /spaces?projectId= performs. The
// client alternative was 1 + N requests (spaces, then every space's full page
// list) re-deriving that access filter for five rows.
export const registerKnowledgeRecentPagesRoutes = (
  app: FastifyInstance,
  deps: KnowledgeRouteDeps,
): void => {
  const { requireActorContext, isProjectAccessibleToActor } = deps
  const { provider, buildViewer } = createKnowledgeAccess(deps)

  app.get('/api/knowledge-base/recent-pages', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    const query = parseInput(KnowledgeRecentPagesQuerySchema, request.query, reply, 'query')
    if (!query) return reply
    const decision = await requireKnowledgePolicy(
      deps,
      actorContext,
      reply,
      'knowledge_page',
      'view',
    )
    if (!decision) return reply
    // A project the caller cannot reach is indistinguishable from one that does
    // not exist — the same 404 the project/board/iteration reads return, so the
    // endpoint never confirms a foreign project's existence with an empty list.
    if (!(await isProjectAccessibleToActor(actorContext, query.projectId))) {
      return sendApiError(reply, 404, 'PROJECT_NOT_FOUND', 'Project not found')
    }
    const viewer = await buildViewer(actorContext)
    const data = await provider.listRecentPages({
      organizationId: actorContext.tenant.organizationId,
      projectId: query.projectId,
      limit: query.limit,
      viewer,
    })
    return createApiResponse(data)
  })
}
