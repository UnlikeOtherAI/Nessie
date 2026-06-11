import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

import { CreateFeedbackRequestSchema, FeedbackRecordSchema } from '@nessie/schemas'
import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import {
  createFeedback,
  FeedbackServiceError,
  listFeedback,
  type FeedbackOwner,
} from '../services/feedback.js'
import type { RouteDeps } from './types.js'

export const registerFeedbackRoutes = (app: FastifyInstance, deps: RouteDeps): void => {
  const { config, prisma, requireActorContext, requireUserActor } = deps

  const ownerFromRequest = (request: FastifyRequest, reply: FastifyReply): FeedbackOwner | null => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return null
    if (!requireUserActor(actorContext, reply)) return null
    return {
      organizationId: actorContext.tenant.organizationId,
      userId: actorContext.actor.actorId,
    }
  }

  app.get('/api/feedback', async (request, reply) => {
    const owner = ownerFromRequest(request, reply)
    if (!owner) return reply

    const feedback = await listFeedback(prisma, owner)
    return createApiResponse(FeedbackRecordSchema.array().parse(feedback))
  })

  app.post('/api/feedback', async (request, reply) => {
    const owner = ownerFromRequest(request, reply)
    if (!owner) return reply

    const body = parseInput(CreateFeedbackRequestSchema, request.body, reply)
    if (!body) return reply

    try {
      const feedback = await createFeedback(prisma, config, owner, body)
      return reply.code(201).send(createApiResponse(FeedbackRecordSchema.parse(feedback)))
    } catch (error) {
      if (error instanceof FeedbackServiceError) {
        sendApiError(reply, error.httpStatus, error.code, error.message)
        return reply
      }
      throw error
    }
  })
}
