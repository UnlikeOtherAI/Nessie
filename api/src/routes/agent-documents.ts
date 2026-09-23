import type { FastifyInstance } from 'fastify'
import {
  agentCoreTokenBudget,
  canReadSpace,
  ensureAgentDocsSpace,
  readCanonicalAgentCore,
  resolveAgentDocumentProjectId,
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
  const { provider, buildViewer, canReadVersion } = createKnowledgeAccess(deps)

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
      select: {
        id: true,
        name: true,
        projectId: true,
        speakingStyle: true,
        systemManaged: true,
        systemPrompt: true,
      },
    })
    if (!agent) {
      return createApiResponse(AgentDocumentsResponseSchema.parse({ space: null }))
    }
    if (agent.systemManaged) {
      return createApiResponse(AgentDocumentsResponseSchema.parse({
        projectedCoreDocuments: [
          { filename: 'AGENTS.md', markdown: agent.systemPrompt ?? '', role: 'identity' },
          { filename: 'personality.md', markdown: agent.speakingStyle ?? '', role: 'working_rules' },
        ],
        space: null,
      }))
    }
    const documentProjectId = await resolveAgentDocumentProjectId(prisma, {
      agentId: agent.id,
      organizationId: actorContext.tenant.organizationId,
      preferredProjectId: agent.projectId,
    })
    // Documents are a human doorway, not a side-effect of whether an agent has
    // a complete tool configuration. Opening the tab provisions the existing
    // home and attempts the one-time legacy core migration.
    const ensured = await ensureAgentDocsSpace(prisma, {
      agentId: agent.id,
      agentName: agent.name,
      organizationId: actorContext.tenant.organizationId,
      projectId: documentProjectId,
    })
    // Establish the request's durable inference origin before the provider
    // transaction queues its derived Markdown projection for indexing.
    const viewer = await buildViewer(actorContext)
    await migrateLegacyAgentCoreDocuments(prisma, provider, deps.fileService, {
      agentId: agent.id,
      attribution: attributionFromActorContext(actorContext),
      organizationId: actorContext.tenant.organizationId,
      userId: actorContext.actor.actorId,
    })
    const reference = await prisma.knowledgeSpace.findUnique({
      where: { id: ensured.spaceId }, select: { id: true, name: true },
    })
    if (!reference) return createApiResponse(AgentDocumentsResponseSchema.parse({ space: null }))

    // Agent visibility and document readability are separate entitlements.
    // Resolve the canonical knowledge read verdict so the tab can explain an
    // unreadable home instead of mounting a team whose requests all 403.
    const space = await provider.getSpace(actorContext.tenant.organizationId, reference.id)
    if (!space) {
      return createApiResponse(AgentDocumentsResponseSchema.parse({ space: null }))
    }
    if (!canReadSpace(space, viewer)) {
      return createApiResponse(AgentDocumentsResponseSchema.parse({
        space: { canRead: false },
      }))
    }

    const versionReadDenied = new Error('Agent core version read denied')
    let canonicalCore: Awaited<ReturnType<typeof readCanonicalAgentCore>> = null
    try {
      canonicalCore = await readCanonicalAgentCore(prisma, deps.fileService, {
        agentId: agent.id,
        authorize: async (document) => {
          if (document.spaceId !== reference.id
            || !canReadSpace(space, viewer)
            || !canReadVersion(viewer, document)) {
            throw versionReadDenied
          }
        },
        organizationId: actorContext.tenant.organizationId,
      })
    } catch (error) {
      if (error !== versionReadDenied) throw error
    }

    return createApiResponse(AgentDocumentsResponseSchema.parse({
      ...(canonicalCore
        ? {
            core: canonicalCore.estimatedTokens > agentCoreTokenBudget()
              ? {
                  estimatedTokens: canonicalCore.estimatedTokens,
                  state: 'oversized' as const,
                  tokenBudget: agentCoreTokenBudget(),
                }
              : { estimatedTokens: canonicalCore.estimatedTokens, state: 'active' as const },
          }
        : {}),
      ...(canonicalCore
        ? {
            coreDocuments: canonicalCore.documents.map((document) => ({
              ...document,
              filename: document.role === 'identity' ? 'AGENTS.md' : 'personality.md',
            })),
          }
        : {}),
      space: {
        ...reference,
        canRead: true,
      },
    }))
  })
}
