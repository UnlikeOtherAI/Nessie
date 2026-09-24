import type { FastifyInstance } from 'fastify'
import type { KnowledgePageRecord } from '@nessie/knowledge'
import { SpaceDocumentTriggersRecordSchema } from '@nessie/schemas'
import { loadDocumentReviews } from '@nessie/team-admin'
import { z } from 'zod'

import { createApiResponse, parseInput } from '../lib/api.js'
import { createKnowledgeAccess, requireKnowledgePolicy, type KnowledgeRouteDeps } from './knowledge-base-access.js'

/**
 * What a document browser shows of document triggers
 * (docs/standards/document-triggers.md → "What a person sees"):
 *
 *   GET /api/knowledge-base/spaces/:spaceId/document-triggers?pageIds=a,b,c
 *
 * Behind the space's own read rule and each page's own disclosure, never the
 * owner-only Triggers routes: the row badge *"Reviewed by CTO · v5"* for each
 * listed page a document trigger has reviewed, the review thread only for a
 * viewer who may open it, and whether "Tell an agent when this changes…" is
 * offered — the Triggers routes' own `requireOwner`, asked on the server.
 */

const MAX_PAGE_IDS = 100

const QuerySchema = z.object({
  pageIds: z
    .string()
    .optional()
    .transform((value) => (value ? [...new Set(value.split(',').map((id) => id.trim()).filter(Boolean))] : []))
    .pipe(z.array(z.string().uuid()).max(MAX_PAGE_IDS)),
})

export const registerKnowledgeDocumentTriggerRoutes = (app: FastifyInstance, deps: KnowledgeRouteDeps): void => {
  const { prisma, requireActorContext, requireUserActor } = deps
  const { accessSpace, buildViewer, filterReadablePages, provider } = createKnowledgeAccess(deps)

  app.get('/api/knowledge-base/spaces/:spaceId/document-triggers', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireUserActor(actorContext, reply)) return reply
    const query = parseInput(QuerySchema, request.query, reply, 'query')
    if (!query) return reply
    const decision = await requireKnowledgePolicy(deps, actorContext, reply, 'knowledge_page', 'view')
    if (!decision) return reply
    const { spaceId } = request.params as { spaceId: string }
    const viewer = await buildViewer(actorContext)
    const space = await accessSpace(actorContext, spaceId, viewer, 'read', reply)
    if (!space) return reply
    const organizationId = actorContext.tenant.organizationId
    const pages = (await Promise.all(query.pageIds.map((pageId) => provider.getPage(organizationId, pageId))))
      .filter((page): page is KnowledgePageRecord => page !== null && page.spaceId === space.id)
    const readable = await filterReadablePages(viewer, pages)
    const reviews = await loadDocumentReviews(prisma, {
      organizationId,
      pageIds: readable.map((page) => page.id),
      viewerUserId: actorContext.actor.actorId,
    })
    return createApiResponse(SpaceDocumentTriggersRecordSchema.parse({
      viewerCanCreateTriggers: actorContext.actor.roles?.includes('owner') === true,
      projectId: space.projectId,
      reviews,
    }))
  })
}
