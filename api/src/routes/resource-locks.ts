import type { FastifyInstance } from 'fastify'

import { AcquireResourceLockBodySchema, ResourceLockRecordSchema } from '../contracts.js'
import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import {
  acquireResourceLock,
  listResourceLocks,
  releaseResourceLock,
} from '../services/resource-locks.js'
import type { RouteDeps } from './types.js'

export const registerResourceLockRoutes = (app: FastifyInstance, deps: RouteDeps): void => {
  const { prisma, requireActorContext, requireOwner } = deps

  app.get('/api/resource-locks', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }
    if (!requireOwner(actorContext, reply)) {
      return reply
    }

    const query = request.query as { agentId?: string }
    const locks = await listResourceLocks(prisma, actorContext.tenant.organizationId, query)
    return createApiResponse(ResourceLockRecordSchema.array().parse(locks))
  })

  app.post('/api/resource-locks/acquire', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }
    if (!requireOwner(actorContext, reply)) {
      return reply
    }

    const body = parseInput(AcquireResourceLockBodySchema, request.body, reply)
    if (!body) {
      return reply
    }

    const lock = await acquireResourceLock(prisma, actorContext.tenant.organizationId, body)
    if (!lock) {
      sendApiError(reply, 409, 'RESOURCE_LOCK_CONFLICT', 'Resource is already locked')
      return reply
    }

    return reply.code(201).send(createApiResponse(ResourceLockRecordSchema.parse(lock)))
  })

  app.post('/api/resource-locks/:lockId/release', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }
    if (!requireOwner(actorContext, reply)) {
      return reply
    }

    const { lockId } = request.params as { lockId: string }
    const lock = await releaseResourceLock(prisma, actorContext.tenant.organizationId, lockId)
    if (!lock) {
      sendApiError(reply, 404, 'RESOURCE_LOCK_NOT_FOUND', 'Resource lock not found')
      return reply
    }

    return createApiResponse(ResourceLockRecordSchema.parse(lock))
  })
}
