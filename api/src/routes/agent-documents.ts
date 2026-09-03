import type { FastifyInstance } from 'fastify'
import {
  canReadSpace,
  createNativeKnowledgeProvider,
  loadSpaceViewer,
  type KnowledgeProvider,
} from '@nessie/knowledge'
import { AgentDocumentsResponseSchema } from '@nessie/schemas'

import { createApiResponse, sendApiError } from '../lib/api.js'
import type { RouteDeps } from './types.js'

type AgentDocumentRouteDeps = RouteDeps & {
  knowledgeProvider?: KnowledgeProvider
}

/**
 * The thin human-facing reference from an agent to its documents home. Page,
 * file, and settings requests continue through the knowledge routes and their
 * canonical per-space read/write checks.
 */
export const registerAgentDocumentRoutes = (
  app: FastifyInstance,
  deps: AgentDocumentRouteDeps,
): void => {
  const { prisma, requireActorContext, isAgentAccessibleToActor } = deps
  const provider = deps.knowledgeProvider ?? createNativeKnowledgeProvider(prisma)

  app.get('/api/agents/:agentId/docs', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply

    const { agentId } = request.params as { agentId: string }
    if (!(await isAgentAccessibleToActor(actorContext, agentId))) {
      sendApiError(reply, 404, 'AGENT_NOT_FOUND', 'Agent not found')
      return reply
    }

    // GET never provisions. The worker owns lazy home creation at run setup;
    // before that happens, null is the honest state of this sub-resource.
    const reference = await prisma.knowledgeSpace.findFirst({
      where: {
        deletedAt: null,
        organizationId: actorContext.tenant.organizationId,
        ownerAgentId: agentId,
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true, name: true },
    })
    if (!reference) {
      return createApiResponse(AgentDocumentsResponseSchema.parse({ space: null }))
    }

    // Agent visibility and document readability are separate entitlements.
    // Resolve the canonical knowledge read verdict so the tab can explain an
    // unreadable home instead of mounting a team whose requests all 403.
    const actorType = actorContext.actor.actorType
    const principal = actorType === 'user' || actorType === 'agent'
      ? { actorId: actorContext.actor.actorId, actorType }
      : { actorId: actorContext.actor.actorId, actorType: 'service' as const }
    const [space, viewer] = await Promise.all([
      provider.getSpace(actorContext.tenant.organizationId, reference.id),
      loadSpaceViewer(prisma, actorContext.tenant.organizationId, principal),
    ])
    if (!space) {
      return createApiResponse(AgentDocumentsResponseSchema.parse({ space: null }))
    }
    if (!canReadSpace(space, viewer)) {
      return createApiResponse(AgentDocumentsResponseSchema.parse({
        space: { canRead: false },
      }))
    }

    return createApiResponse(AgentDocumentsResponseSchema.parse({
      space: {
        ...reference,
        canRead: true,
      },
    }))
  })
}
