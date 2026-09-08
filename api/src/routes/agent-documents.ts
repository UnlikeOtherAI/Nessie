import type { FastifyInstance } from 'fastify'
import {
  canReadSpace,
  ensureAgentDocsSpace,
  loadSpaceViewer,
  type KnowledgeProvider,
} from '@nessie/knowledge'
import { attributionFromActorContext } from '@nessie/runtime'
import { AgentDocumentsResponseSchema } from '@nessie/schemas'

import { createApiResponse, sendApiError } from '../lib/api.js'
import type { RouteDeps } from './types.js'
import { createKnowledgeAccess } from './knowledge-base-access.js'
import { migrateLegacyAgentCoreDocuments } from '../services/agent-core-documents.js'

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
  const { provider, buildViewer } = createKnowledgeAccess(deps)

  app.get('/api/agents/:agentId/docs', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply

    const { agentId } = request.params as { agentId: string }
    if (!(await isAgentAccessibleToActor(actorContext, agentId))) {
      sendApiError(reply, 404, 'AGENT_NOT_FOUND', 'Agent not found')
      return reply
    }

    const agent = await prisma.agent.findFirst({
      where: { id: agentId, organizationId: actorContext.tenant.organizationId },
      select: { id: true, name: true, projectId: true, systemManaged: true },
    })
    if (!agent || agent.systemManaged || !agent.projectId) {
      return createApiResponse(AgentDocumentsResponseSchema.parse({ space: null }))
    }
    // Documents are a human doorway, not a side-effect of whether an agent has
    // a complete tool configuration. Opening the tab provisions the existing
    // home and attempts the one-time legacy core migration.
    const ensured = await ensureAgentDocsSpace(prisma, {
      agentId: agent.id,
      agentName: agent.name,
      organizationId: actorContext.tenant.organizationId,
      projectId: agent.projectId,
    })
    // Establish the request's durable inference origin before the provider
    // transaction queues its derived Markdown projection for indexing.
    await buildViewer(actorContext)
    const core = await migrateLegacyAgentCoreDocuments(prisma, provider, deps.fileService, {
      agentId: agent.id,
      attribution: attributionFromActorContext(actorContext),
      organizationId: actorContext.tenant.organizationId,
      projectId: agent.projectId,
      userId: actorContext.actor.actorId,
    })
    const reference = await prisma.knowledgeSpace.findUnique({
      where: { id: ensured.spaceId }, select: { id: true, name: true },
    })
    if (!reference) return createApiResponse(AgentDocumentsResponseSchema.parse({ space: null }))

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
      core,
      space: {
        ...reference,
        canRead: true,
      },
    }))
  })
}
