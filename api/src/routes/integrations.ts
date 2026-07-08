import type { FastifyInstance } from 'fastify'
import {
  IntegratedProductResponseSchema,
  IntegrationPluginManifestSchema,
} from '@nessie/schemas'
import { z } from 'zod'

import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import { getIntegrationPluginManifest } from '../services/integration-plugin-manifests.js'
import { listIntegratedProducts } from '../services/integrations.js'
import type { RouteDeps } from './types.js'

const ProductSlugParamsSchema = z.object({
  productSlug: z.string().min(1),
})

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

  app.get('/api/integrations/products/:productSlug/manifest', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireUserActor(actorContext, reply)) return reply

    const params = parseInput(ProductSlugParamsSchema, request.params, reply, 'params')
    if (!params) return reply

    const manifest = getIntegrationPluginManifest(params.productSlug)
    if (!manifest) {
      sendApiError(reply, 404, 'INTEGRATION_MANIFEST_NOT_FOUND', 'Integration manifest not found')
      return reply
    }

    return createApiResponse(IntegrationPluginManifestSchema.parse(manifest))
  })
}
