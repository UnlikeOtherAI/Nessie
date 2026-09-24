import type { FastifyInstance } from 'fastify'
import {
  endStandingPolicyByPerson,
  getExecutorForManagement,
  listExecutorStandingPolicies,
} from '@nessie/executor-manage'
import {
  EndStandingPolicyResponseSchema,
  ExecutorStandingPolicyListResponseSchema,
  isAdminActor,
  StandingPolicyMachineOptionsResponseSchema,
  TriggerMachineAccessViewSchema,
} from '@nessie/schemas'
import {
  listStandingPolicyMachineOptions,
  loadExecutorHoldingTicket,
  loadTriggerMachineAccess,
} from '@nessie/team-admin'
import { z } from 'zod'

import { createApiResponse, sendApiError } from '../lib/api.js'
import type { RouteDeps } from './types.js'

const UuidSchema = z.string().uuid()

const idOf = (params: unknown, key: string): string | null => {
  const parsed = UuidSchema.safeParse((params as Record<string, unknown>)[key])
  return parsed.success ? parsed.data : null
}

/**
 * What the screens read of standing machine access, and the End a person
 * presses (docs/standards/ticket-work-machine-access.md → "What the screens
 * show"):
 *
 * - `GET /api/triggers/:triggerId/machine-access` — a ticket trigger's Machine
 *   access section, for the Triggers routes' readers (owners) and the
 *   trigger's author; anyone else is "not found". Machines are named only to
 *   the author and the machines' administrators.
 * - `GET /api/triggers/:triggerId/machine-access/machines` — the author's own
 *   private machines for the setup form; nobody else's, and nobody else.
 * - `GET /api/executors/:executorId/standing-policies` — the executor page's
 *   Standing access panel, for the people who administer the machine.
 * - `POST /api/standing-policies/:policyId/end` — its author, or an
 *   administrator of one of its machines; "not found" for anyone else.
 */
export const registerStandingPolicyViewRoutes = (app: FastifyInstance, deps: RouteDeps): void => {
  const { prisma, requireActorContext, requireUserActor } = deps

  app.get('/api/triggers/:triggerId/machine-access', async (request, reply) => {
    const actor = requireActorContext(request, reply)
    if (!actor || !requireUserActor(actor, reply)) return reply
    const triggerId = idOf(request.params, 'triggerId')
    const view = triggerId ? await loadTriggerMachineAccess(prisma, {
      organizationId: actor.tenant.organizationId, triggerId, viewerUserId: actor.actor.actorId,
    }) : null
    if (!view || (!view.viewerIsAuthor && !actor.actor.roles?.includes('owner'))) {
      sendApiError(reply, 404, 'TRIGGER_NOT_FOUND', 'Trigger not found')
      return reply
    }
    return createApiResponse(TriggerMachineAccessViewSchema.parse(view))
  })

  app.get('/api/triggers/:triggerId/machine-access/machines', async (request, reply) => {
    const actor = requireActorContext(request, reply)
    if (!actor || !requireUserActor(actor, reply)) return reply
    const triggerId = idOf(request.params, 'triggerId')
    const view = triggerId ? await loadTriggerMachineAccess(prisma, {
      organizationId: actor.tenant.organizationId, triggerId, viewerUserId: actor.actor.actorId,
    }) : null
    if (!view) {
      sendApiError(reply, 404, 'TRIGGER_NOT_FOUND', 'Trigger not found')
      return reply
    }
    if (!view.viewerIsAuthor) {
      const name = view.author?.name ?? 'the person who set it up'
      sendApiError(reply, 403, 'MACHINE_ACCESS_REFUSED',
        `Only ${name}, who set this trigger up, can set up machine access for it.`)
      return reply
    }
    const machines = await listStandingPolicyMachineOptions(prisma, {
      authorUserId: actor.actor.actorId, organizationId: actor.tenant.organizationId,
    })
    return createApiResponse(StandingPolicyMachineOptionsResponseSchema.parse({ machines }))
  })

  app.get('/api/executors/:executorId/standing-policies', async (request, reply) => {
    const actor = requireActorContext(request, reply)
    if (!actor || !requireUserActor(actor, reply)) return reply
    const executorId = idOf(request.params, 'executorId')
    const managed = executorId ? await getExecutorForManagement(prisma, actor, executorId) : null
    if (!executorId || !managed) {
      sendApiError(reply, 404, 'EXECUTOR_NOT_FOUND', 'Executor not found.')
      return reply
    }
    const policies = await listExecutorStandingPolicies(prisma, {
      executorId, organizationId: actor.tenant.organizationId, userId: actor.actor.actorId,
    })
    // Which ticket holds the machine, on the row of the policy it holds it under.
    const holder = await loadExecutorHoldingTicket(prisma, {
      executorId, isOrganizationAdmin: isAdminActor(actor), organizationId: actor.tenant.organizationId,
      viewerUserId: actor.actor.actorId,
    })
    return createApiResponse(ExecutorStandingPolicyListResponseSchema.parse({
      policies: policies.map((policy) => ({
        ...policy, holdingTicket: holder && holder.policyId === policy.id ? holder.ticket : null,
      })),
    }))
  })

  app.post('/api/standing-policies/:policyId/end', async (request, reply) => {
    const actor = requireActorContext(request, reply)
    if (!actor || !requireUserActor(actor, reply)) return reply
    const policyId = idOf(request.params, 'policyId')
    const outcome = policyId ? await endStandingPolicyByPerson(prisma, {
      organizationId: actor.tenant.organizationId,
      policyId,
      requestId: actor.actionContext.requestId,
      userId: actor.actor.actorId,
    }) : 'not_found'
    if (outcome === 'not_found') {
      sendApiError(reply, 404, 'STANDING_POLICY_NOT_FOUND', 'Machine access not found.')
      return reply
    }
    return createApiResponse(EndStandingPolicyResponseSchema.parse({ ended: outcome === 'ended' }))
  })
}
