import type { FastifyInstance } from 'fastify'

import {
  AgentTriggerRecordSchema,
  ReauthorizeAgentTriggerBodySchema,
} from '../contracts.js'
import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import {
  getAgentTrigger,
  pauseAgentTrigger,
  reauthorizeAgentTrigger,
  resumeAgentTrigger,
} from '../services/triggers.js'
import type { RouteDeps } from './types.js'

/**
 * Changing whether a trigger runs: reauthorize, pause, resume.
 *
 * Split from `./triggers.ts` (trigger CRUD, firing, history) to keep each file
 * under the 500-line cap (AGENTS.md), along the seam these three share — they
 * all move a schedule between running and not-running states, and none of them
 * changes what it does. Registration order is preserved by the caller.
 */
export const registerTriggerLifecycleRoutes = (
  app: FastifyInstance,
  deps: RouteDeps,
): void => {
  const {
    prisma,
    requireActorContext,
    requireOwner,
    requireUserActor,
    isTriggerAccessibleToActor,
  } = deps

  // Recovery doorway for a schedule whose captured identity stopped verifying.
  // Deliberately explicit rather than an automatic re-stamp on login: signing in
  // proves the same person is here, not that they intend a dormant automation to
  // start running again — and the epoch may have rotated because access was
  // withdrawn.
  app.post('/api/triggers/:triggerId/reauthorize', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    if (!requireUserActor(actorContext, reply)) {
      return reply
    }

    const { triggerId } = request.params as { triggerId: string }
    const trigger = await getAgentTrigger(prisma, triggerId)
    if (!trigger) {
      sendApiError(reply, 404, 'TRIGGER_NOT_FOUND', 'Trigger not found')
      return reply
    }

    if (!(await isTriggerAccessibleToActor(actorContext, trigger))) {
      sendApiError(reply, 404, 'TRIGGER_NOT_FOUND', 'Trigger not found')
      return reply
    }

    const body = parseInput(ReauthorizeAgentTriggerBodySchema, request.body ?? {}, reply)
    if (!body) {
      return reply
    }

    const result = await reauthorizeAgentTrigger(prisma, {
      actorContext,
      isOwner: actorContext.actor.roles?.includes('owner') ?? false,
      ...(body.takeOver === undefined ? {} : { takeOver: body.takeOver }),
      triggerId,
    })
    if (result.kind === 'error') {
      sendApiError(reply, result.status, result.code, result.message)
      return reply
    }

    return createApiResponse(AgentTriggerRecordSchema.parse(result.trigger))
  })

  app.post('/api/triggers/:triggerId/pause', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    if (!requireOwner(actorContext, reply)) {
      return reply
    }

    const { triggerId } = request.params as { triggerId: string }
    const trigger = await getAgentTrigger(prisma, triggerId)
    if (!trigger) {
      sendApiError(reply, 404, 'TRIGGER_NOT_FOUND', 'Trigger not found')
      return reply
    }

    if (!(await isTriggerAccessibleToActor(actorContext, trigger))) {
      sendApiError(reply, 404, 'TRIGGER_NOT_FOUND', 'Trigger not found')
      return reply
    }

    const updated = await pauseAgentTrigger(prisma, triggerId)
    if (!updated) {
      sendApiError(reply, 404, 'TRIGGER_NOT_FOUND', 'Trigger not found')
      return reply
    }

    return createApiResponse(AgentTriggerRecordSchema.parse(updated))
  })

  app.post('/api/triggers/:triggerId/resume', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    if (!requireOwner(actorContext, reply)) {
      return reply
    }

    const { triggerId } = request.params as { triggerId: string }
    const trigger = await getAgentTrigger(prisma, triggerId)
    if (!trigger) {
      sendApiError(reply, 404, 'TRIGGER_NOT_FOUND', 'Trigger not found')
      return reply
    }

    if (!(await isTriggerAccessibleToActor(actorContext, trigger))) {
      sendApiError(reply, 404, 'TRIGGER_NOT_FOUND', 'Trigger not found')
      return reply
    }

    const updated = await resumeAgentTrigger(prisma, triggerId)
    if (!updated) {
      sendApiError(reply, 404, 'TRIGGER_NOT_FOUND', 'Trigger not found')
      return reply
    }

    return createApiResponse(AgentTriggerRecordSchema.parse(updated))
  })
}
