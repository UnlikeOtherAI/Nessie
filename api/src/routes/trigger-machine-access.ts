import type { FastifyInstance } from 'fastify'
import { ExecutorError } from '@nessie/executor-manage'
import {
  isAdminActor,
  PreparedStandingPolicyResponseSchema,
  PrepareStandingPolicyBodySchema,
} from '@nessie/schemas'
import { prepareStandingPolicy, StandingPolicyRefusal } from '@nessie/team-admin'

import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import { sendExecutorError } from './executor-route-errors.js'
import type { RouteDeps } from './types.js'

/**
 * A ticket trigger's standing machine access, prepared by its author from the
 * trigger's Machine access section
 * (docs/plans/2026-09-23-ticket-driven-agents/machine-access.md → "Prepare
 * and confirm"; docs/standards/ticket-work.md).
 *
 * Author-only, not owner-only like the rest of the Triggers routes: the work
 * would run on the author's own machines as them, and anyone else preparing
 * it would learn which private machines they have. The answer carries the
 * confirmation token to the author's own browser, as preparing any executor
 * access change does, and the card that says in plain words what they would
 * agree to; they confirm it through `POST
 * /api/executor-access-changes/:id/confirm` with their password, which
 * applies every machine's assignment, grant and tool enablement and the
 * policy in one transaction.
 */
export const registerTriggerMachineAccessRoutes = (app: FastifyInstance, deps: RouteDeps): void => {
  const { prisma, requireActorContext } = deps

  app.post('/api/triggers/:triggerId/machine-access', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (actorContext.actor.actorType !== 'user') {
      sendApiError(reply, 403, 'MACHINE_ACCESS_REFUSED', 'Only a person can set up machine access.')
      return reply
    }
    const body = parseInput(PrepareStandingPolicyBodySchema, request.body, reply)
    if (!body) return reply
    const { triggerId } = request.params as { triggerId: string }
    try {
      const prepared = await prepareStandingPolicy(prisma, actorContext, { ...body, triggerId }, {
        isOrganizationAdmin: isAdminActor(actorContext),
      })
      return reply.code(201).send(createApiResponse(PreparedStandingPolicyResponseSchema.parse({
        accessChangeId: prepared.accessChangeId,
        card: prepared.card,
        confirmationToken: prepared.confirmationToken,
        expiresAt: prepared.expiresAt.toISOString(),
        policyId: prepared.policyId,
        requiresFreshVerification: true,
      })))
    } catch (error) {
      if (error instanceof StandingPolicyRefusal) {
        const status = error.message === 'Trigger not found.' ? 404 : 400
        sendApiError(reply, status, status === 404 ? 'TRIGGER_NOT_FOUND' : error.code, error.message, undefined,
          error.machines.length > 0 ? { machines: error.machines } : undefined)
        return reply
      }
      if (error instanceof ExecutorError && sendExecutorError(reply, error)) return reply
      throw error
    }
  })
}
