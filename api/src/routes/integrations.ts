import type { FastifyInstance } from 'fastify'
import { IntegratedProductResponseSchema } from '@nessie/schemas'

import { createApiResponse } from '../lib/api.js'
import { listIntegratedProducts } from '../services/integrations.js'
import type { RouteDeps } from './types.js'

export const registerIntegrationRoutes = (app: FastifyInstance, deps: RouteDeps): void => {
  const { prisma, requireActorContext, requireUserActor } = deps

  app.get('/api/integrations/products', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireUserActor(actorContext, reply)) return reply

    const products = await listIntegratedProducts(prisma, {
      organizationId: actorContext.tenant.organizationId,
      userId: actorContext.actor.actorId,
    })

    return createApiResponse(IntegratedProductResponseSchema.array().parse(products))
  })
}
