import type { FastifyInstance } from 'fastify'
import { parseAgentId } from '@nessie/schemas'

import { sendApiError } from '../lib/api.js'
import { deleteAgent } from '../services/agent-delete.js'
import { emitAuditEvent } from '../services/audit.js'
import type { RouteDeps } from './types.js'

/**
 * `DELETE /api/agents/:agentId`.
 *
 * Before this existed, the members popup offered a one-tap "duplicate" that
 * created an agent no UI and no endpoint could remove; one such row had to be
 * deleted straight out of the production database. A create with no delete is
 * the unreachable-capability defect Rule zero names, pointed the other way.
 *
 * Its own module because `routes/agents.ts` is long past the file-size cap, and
 * because the revocation this triggers is a subsystem rather than a handler.
 */
export const registerAgentDeleteRoutes = (app: FastifyInstance, deps: RouteDeps): void => {
  const { prisma, realtimeHub, requireActorContext, requireUserActor } = deps

  app.delete('/api/agents/:agentId', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireUserActor(actorContext, reply)) return reply

    const { agentId } = request.params as { agentId: string }
    const outcome = await deleteAgent(prisma, actorContext, agentId)

    if (outcome.kind === 'not_found') {
      sendApiError(reply, 404, 'AGENT_NOT_FOUND', 'Agent not found')
      return reply
    }
    if (outcome.kind === 'refused') {
      // Every refusal here is a 403 and carries its own code, so the client can
      // tell "this agent is Nessie's own" (`SYSTEM_AGENT_IMMUTABLE`) from "it is
      // somebody else's" without reading the sentence. The agent's existence is
      // already known to the caller — it was in their list — so there is
      // nothing a 404 would protect.
      sendApiError(reply, 403, outcome.code, outcome.message)
      return reply
    }

    await emitAuditEvent(prisma, {
      actorContext,
      action: 'agent.deleted',
      resourceId: outcome.agentId,
      resourceType: 'agent',
      outcome: 'success',
    })

    // `agent.updated`, deliberately, and not a new `agent.deleted` kind. The
    // client's handler for it invalidates the whole agent cache, so the row
    // disappears from the list without a refresh — which is all a delete needs.
    // Introducing a realtime kind is a mixed-version deploy hazard: a replica
    // still running the previous build receives a payload whose event it does
    // not know, and this estate has twice taken an outage from exactly that.
    await realtimeHub.publishWs(
      [
        { kind: 'organization', organizationId: actorContext.tenant.organizationId },
        { kind: 'agent', agentId: parseAgentId(outcome.agentId) },
      ],
      { data: { agentId: parseAgentId(outcome.agentId) }, event: 'agent.updated' },
    )

    return reply.code(204).send()
  })
}
