import type { FastifyInstance } from 'fastify'
import { createApiResponse } from '../lib/api.js'
import { emitAuditEvent } from '../services/audit.js'
import { ensureLibrarianAgent } from '../services/librarian.js'
import {
  requireKnowledgePolicy,
  requestIds,
  type KnowledgeRouteDeps,
} from './knowledge-base-access.js'

// Split out from knowledge-base.ts (already at the 500-line file cap) rather
// than grown inline there. Bootstraps the org's shared, system-managed
// Librarian agent — read-only knowledge-base research today; future phases
// may grant it drafting tools, but that is out of scope here.
export const registerKnowledgeLibrarianRoutes = (
  app: FastifyInstance,
  deps: KnowledgeRouteDeps,
): void => {
  const { prisma, requireActorContext } = deps

  app.post('/api/knowledge-base/librarian', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    // Same gate as creating a knowledge space: bootstrapping the org's
    // Librarian agent is itself a knowledge-base provisioning action.
    const decision = await requireKnowledgePolicy(deps, actorContext, reply, 'knowledge_space', 'create')
    if (!decision) return reply

    const agentId = await ensureLibrarianAgent(prisma, actorContext.tenant.organizationId)

    await emitAuditEvent(prisma, {
      actorContext,
      action: 'kb.librarian.ensured',
      resourceType: 'agent',
      resourceId: agentId,
      outcome: 'success',
      ...requestIds(request),
    })

    return reply.code(200).send(createApiResponse({ agentId }))
  })
}
