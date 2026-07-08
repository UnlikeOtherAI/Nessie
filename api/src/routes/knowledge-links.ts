import type { FastifyInstance } from 'fastify'
import { listBacklinks, listUnlinkedMentions } from '@nessie/knowledge'
import { createApiResponse, sendApiError } from '../lib/api.js'
import {
  createKnowledgeAccess,
  requireKnowledgePolicy,
  type KnowledgeRouteDeps,
} from './knowledge-base-access.js'

// Read-only wikilink surfaces for a page: who links to it (backlinks) and who
// mentions its title in plain text without linking yet (unlinked mentions).
// Split out from knowledge-base.ts (already at the 500-line file cap),
// mirroring the knowledge-librarian.ts precedent.
export const registerKnowledgeLinkRoutes = (
  app: FastifyInstance,
  deps: KnowledgeRouteDeps,
): void => {
  const { requireActorContext } = deps
  const { provider, buildViewer, accessPageSpace } = createKnowledgeAccess(deps)

  app.get('/api/knowledge-base/pages/:pageId/backlinks', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    const decision = await requireKnowledgePolicy(deps, actorContext, reply, 'knowledge_page', 'read')
    if (!decision) return reply
    const { pageId } = request.params as { pageId: string }
    const organizationId = actorContext.tenant.organizationId
    const page = await provider.getPage(organizationId, pageId)
    if (!page) {
      return sendApiError(reply, 404, 'KNOWLEDGE_PAGE_NOT_FOUND', 'Page not found')
    }
    const viewer = await buildViewer(actorContext)
    if (!(await accessPageSpace(actorContext, page, viewer, 'read', reply))) return reply
    const data = await listBacklinks(deps.prisma, { organizationId, pageId, viewer })
    return createApiResponse(data)
  })

  app.get('/api/knowledge-base/pages/:pageId/mentions', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    const decision = await requireKnowledgePolicy(deps, actorContext, reply, 'knowledge_page', 'read')
    if (!decision) return reply
    const { pageId } = request.params as { pageId: string }
    const organizationId = actorContext.tenant.organizationId
    const page = await provider.getPage(organizationId, pageId)
    if (!page) {
      return sendApiError(reply, 404, 'KNOWLEDGE_PAGE_NOT_FOUND', 'Page not found')
    }
    const viewer = await buildViewer(actorContext)
    if (!(await accessPageSpace(actorContext, page, viewer, 'read', reply))) return reply
    const data = await listUnlinkedMentions(deps.prisma, { organizationId, pageId, viewer })
    return createApiResponse(data)
  })
}
