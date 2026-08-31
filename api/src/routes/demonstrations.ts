import type { FastifyInstance } from 'fastify'
import {
  CreateDemonstrationBodySchema,
  DemonstrationDetailRecordSchema,
  DemonstrationParamsSchema,
  DemonstrationRecordSchema,
} from '../contracts.js'
import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import {
  DemonstrationError,
  getDemonstrationForUser,
  listDemonstrationsForUser,
  startDemonstration,
  stopDemonstration,
} from '@nessie/workspace-admin'

import type { RouteDeps } from './types.js'

const sendDemonstrationError = (
  reply: Parameters<typeof sendApiError>[0],
  error: unknown,
): boolean => {
  if (!(error instanceof DemonstrationError)) return false
  if (error.code === 'NOT_RECORDING' || error.code === 'RECORDING_ALREADY_ACTIVE') {
    sendApiError(reply, 409, error.code, error.code === 'NOT_RECORDING'
      ? 'This demonstration is no longer recording.'
      : 'A demonstration is already recording for this agent and thread.')
    return true
  }
  sendApiError(reply, 404, error.code, 'Demonstration target not found')
  return true
}

/** Review-only demonstration capture; P2 is responsible for any workflow draft. */
export const registerDemonstrationRoutes = (app: FastifyInstance, deps: RouteDeps): void => {
  const { prisma, requireActorContext, requireUserActor } = deps

  app.get('/api/demonstrations', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext || !requireUserActor(actorContext, reply)) return reply
    const demonstrations = await listDemonstrationsForUser(prisma, {
      organizationId: actorContext.tenant.organizationId,
      userId: actorContext.actor.actorId,
    })
    return createApiResponse(DemonstrationRecordSchema.array().parse(demonstrations))
  })

  app.get('/api/demonstrations/:demonstrationId', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext || !requireUserActor(actorContext, reply)) return reply
    const params = parseInput(DemonstrationParamsSchema, request.params, reply, 'params')
    if (!params) return reply
    const demonstration = await getDemonstrationForUser(prisma, {
      demonstrationId: params.demonstrationId,
      organizationId: actorContext.tenant.organizationId,
      userId: actorContext.actor.actorId,
    })
    if (!demonstration) {
      sendApiError(reply, 404, 'DEMONSTRATION_NOT_FOUND', 'Demonstration not found')
      return reply
    }
    return createApiResponse(DemonstrationDetailRecordSchema.parse(demonstration))
  })

  app.post('/api/demonstrations', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext || !requireUserActor(actorContext, reply)) return reply
    const body = parseInput(CreateDemonstrationBodySchema, request.body, reply)
    if (!body) return reply
    try {
      const result = await startDemonstration(prisma, { actorContext, ...body })
      const response = createApiResponse(DemonstrationRecordSchema.parse(result.demonstration))
      return result.created ? reply.code(201).send(response) : response
    } catch (error) {
      if (sendDemonstrationError(reply, error)) return reply
      throw error
    }
  })

  app.post('/api/demonstrations/:demonstrationId/stop', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext || !requireUserActor(actorContext, reply)) return reply
    const params = parseInput(DemonstrationParamsSchema, request.params, reply, 'params')
    if (!params) return reply
    try {
      const demonstration = await stopDemonstration(prisma, {
        actorContext,
        demonstrationId: params.demonstrationId,
      })
      if (!demonstration) {
        sendApiError(reply, 404, 'DEMONSTRATION_NOT_FOUND', 'Demonstration not found')
        return reply
      }
      return createApiResponse(DemonstrationRecordSchema.parse(demonstration))
    } catch (error) {
      if (sendDemonstrationError(reply, error)) return reply
      throw error
    }
  })
}
