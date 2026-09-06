import type { FastifyInstance } from 'fastify'

import { CreateTemporaryContextSessionBodySchema, TemporaryContextSessionSchema } from '../contracts/tools.js'
import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import {
  CAPABILITY_ERROR_CODES,
  CapabilityError,
  createTemporaryContextSession,
  dropTemporaryContextSession,
  listTemporaryContextSessions,
} from '../services/capabilities.js'
import type { RouteDeps } from './types.js'

export const registerCapabilityRoutes = (app: FastifyInstance, deps: RouteDeps): void => {
  const { prisma, requireActorContext, requireOwner } = deps

  app.get('/api/capabilities/sessions', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }
    if (!requireOwner(actorContext, reply)) {
      return reply
    }

    const query = request.query as {
      agentId?: string
      includeDropped?: string
      runId?: string
      threadId?: string
    }
    const sessions = await listTemporaryContextSessions(prisma, actorContext.tenant.organizationId, {
      agentId: query.agentId,
      includeDropped: query.includeDropped === 'true',
      runId: query.runId,
      threadId: query.threadId,
    })
    return createApiResponse(TemporaryContextSessionSchema.array().parse(sessions))
  })

  app.post('/api/capabilities/sessions', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }
    if (!requireOwner(actorContext, reply)) {
      return reply
    }

    const body = parseInput(CreateTemporaryContextSessionBodySchema, request.body, reply)
    if (!body) {
      return reply
    }

    let session
    try {
      session = await createTemporaryContextSession(prisma, actorContext, body)
    }
    catch (error) {
      if (error instanceof CapabilityError) {
        const status =
          error.code === CAPABILITY_ERROR_CODES.SCOPE_REQUIRED
          || error.code === CAPABILITY_ERROR_CODES.SCOPE_AMBIGUOUS
            ? 400
            : 404
        sendApiError(reply, status, error.code, error.message)
        return reply
      }
      throw error
    }
    return reply.code(201).send(createApiResponse(TemporaryContextSessionSchema.parse(session)))
  })

  app.delete('/api/capabilities/sessions/:sessionId', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }
    if (!requireOwner(actorContext, reply)) {
      return reply
    }

    const { sessionId } = request.params as { sessionId: string }
    const session = await dropTemporaryContextSession(
      prisma,
      actorContext.tenant.organizationId,
      sessionId,
    )
    if (!session) {
      sendApiError(reply, 404, 'TEMP_CONTEXT_NOT_FOUND', 'Temporary context session not found')
      return reply
    }

    return createApiResponse(TemporaryContextSessionSchema.parse(session))
  })
}
