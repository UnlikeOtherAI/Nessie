import type { FastifyInstance } from 'fastify'
import {
  IntegratedProductResponseSchema,
  IntegrationPluginManifestSchema,
  SetProductTeamEnablementRequestSchema,
} from '@nessie/schemas'

import { createApiResponse, parseInput, sendApiError } from '../../lib/api.js'
import { getIntegrationPluginManifest } from '../../services/integration-plugin-manifests.js'
import { listIntegratedProducts, setProductTeamEnablement } from '../../services/integrations.js'
import type { RouteDeps } from '../types.js'
import { ProductSlugParamsSchema } from './route-schemas.js'

export const registerIntegrationProductRoutes = (
  app: FastifyInstance,
  deps: RouteDeps,
): void => {
  const {
    prisma,
    requireActorContext,
    requireOwner,
    requireUserActor,
  } = deps

  app.get('/api/integrations/products', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireUserActor(actorContext, reply)) return reply

    const products = await listIntegratedProducts(prisma, {
      organizationId: actorContext.tenant.organizationId,
      teamId: actorContext.tenant.teamId,
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

  app.patch('/api/integrations/products/:productSlug/team-enablement', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireUserActor(actorContext, reply)) return reply
    if (!requireOwner(actorContext, reply)) return reply

    const params = parseInput(ProductSlugParamsSchema, request.params, reply, 'params')
    if (!params) return reply
    const body = parseInput(SetProductTeamEnablementRequestSchema, request.body, reply)
    if (!body) return reply

    const teamId = actorContext.tenant.teamId
    if (!teamId) {
      sendApiError(reply, 400, 'TEAM_CONTEXT_REQUIRED', 'A team context is required')
      return reply
    }

    const enablement = await setProductTeamEnablement(prisma, {
      enabled: body.enabled,
      organizationId: actorContext.tenant.organizationId,
      productSlug: params.productSlug,
      teamId,
      userId: actorContext.actor.actorId,
    })
    if (!enablement) {
      sendApiError(reply, 404, 'INTEGRATION_PRODUCT_NOT_FOUND', 'Integration product not found')
      return reply
    }

    const products = await listIntegratedProducts(prisma, {
      organizationId: actorContext.tenant.organizationId,
      teamId,
      userId: actorContext.actor.actorId,
    })
    const product = products.find((candidate) => candidate.slug === params.productSlug)
    if (!product) {
      sendApiError(reply, 404, 'INTEGRATION_PRODUCT_NOT_FOUND', 'Integration product not found')
      return reply
    }

    return createApiResponse(IntegratedProductResponseSchema.parse(product))
  })
}
