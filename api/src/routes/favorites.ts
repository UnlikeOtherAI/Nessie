import type { FastifyInstance } from 'fastify'

import {
  FavoriteRecordSchema,
  FavoriteTargetParamsSchema,
} from '../contracts.js'
import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import {
  FavoriteServiceError,
  listFavorites,
  setFavorite,
  unsetFavorite,
} from '../services/favorites.js'
import type { RouteDeps } from './types.js'

export const registerFavoriteRoutes = (app: FastifyInstance, deps: RouteDeps): void => {
  const { prisma, requireActorContext, requireUserActor } = deps

  app.get('/api/favorites', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireUserActor(actorContext, reply)) return reply

    const favorites = await listFavorites(prisma, {
      organizationId: actorContext.tenant.organizationId,
      userId: actorContext.actor.actorId,
    })
    return createApiResponse(FavoriteRecordSchema.array().parse(favorites))
  })

  app.put('/api/favorites/:targetType/:targetId', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireUserActor(actorContext, reply)) return reply

    const params = parseInput(FavoriteTargetParamsSchema, request.params, reply, 'params')
    if (!params) return reply

    try {
      const favorite = await setFavorite(prisma, {
        includeAllOrgChannels: actorContext.actor.roles?.includes('owner') ?? false,
        organizationId: actorContext.tenant.organizationId,
        targetId: params.targetId,
        targetType: params.targetType,
        userId: actorContext.actor.actorId,
      })
      return createApiResponse(FavoriteRecordSchema.parse(favorite))
    } catch (error) {
      if (error instanceof FavoriteServiceError) {
        sendApiError(reply, error.httpStatus, error.code, error.message)
        return reply
      }
      throw error
    }
  })

  app.delete('/api/favorites/:targetType/:targetId', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireUserActor(actorContext, reply)) return reply

    const params = parseInput(FavoriteTargetParamsSchema, request.params, reply, 'params')
    if (!params) return reply

    await unsetFavorite(prisma, {
      includeAllOrgChannels: actorContext.actor.roles?.includes('owner') ?? false,
      organizationId: actorContext.tenant.organizationId,
      targetId: params.targetId,
      targetType: params.targetType,
      userId: actorContext.actor.actorId,
    })
    return createApiResponse({ ok: true })
  })
}
