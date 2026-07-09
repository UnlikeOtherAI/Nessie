import type { FastifyInstance, FastifyRequest } from 'fastify'
import {
  IntegratedProductResponseSchema,
  IntegrationPluginManifestSchema,
  SetProductTeamEnablementRequestSchema,
} from '@nessie/schemas'
import {
  createPgOAuthStateStore,
  createPgSecretStore,
  startOAuth,
} from '@nessie/mcp-manage'
import { z } from 'zod'

import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import { getIntegrationPluginManifest } from '../services/integration-plugin-manifests.js'
import { listIntegratedProducts, setProductTeamEnablement } from '../services/integrations.js'
import {
  activateExternalAgentProduct,
  deactivateExternalAgentProduct,
  ExternalAgentActivationError,
  EXTERNAL_AGENT_ACTIVATION_ERROR_CODES,
  type ExternalAgentActivationContext,
} from '../services/external-agent-activation.js'
import { buildOAuthCallbackUrl } from './mcp/oauth.js'
import type { RouteDeps } from './types.js'

const ProductSlugParamsSchema = z.object({
  productSlug: z.string().min(1),
})

const ExternalAgentActivationResponseSchema = z.object({
  channelId: z.string().min(1),
  instanceId: z.string().uuid(),
  authorizeUrl: z.string().url().optional(),
})

const ExternalAgentDeactivationResponseSchema = z.object({
  channelId: z.string().min(1).nullable(),
  instanceId: z.string().uuid().nullable(),
})

const activationErrorStatus = (code: string): number => {
  switch (code) {
    case EXTERNAL_AGENT_ACTIVATION_ERROR_CODES.UNKNOWN_PRODUCT:
    case EXTERNAL_AGENT_ACTIVATION_ERROR_CODES.CATALOG_ENTRY_NOT_FOUND:
      return 404
    case EXTERNAL_AGENT_ACTIVATION_ERROR_CODES.TEAM_NOT_ENABLED:
      return 403
    default:
      return 400
  }
}

export const registerIntegrationRoutes = (app: FastifyInstance, deps: RouteDeps): void => {
  const { prisma, requireActorContext, requireOwner, requireUserActor, authSecret } = deps

  // Reuse the exact MCP OAuth machinery so the DeepSignal sign-in flows through
  // the same encrypted store, pg-backed state, and `/api/mcp/oauth/callback`.
  const oauthSecretStore = createPgSecretStore(prisma, authSecret ?? '')
  const oauthStateStore = createPgOAuthStateStore(prisma)

  const buildActivationContext = (
    request: FastifyRequest,
    actorContext: ExternalAgentActivationContext['actorContext'],
  ): ExternalAgentActivationContext => ({
    actorContext,
    organizationId: actorContext.tenant.organizationId,
    userId: actorContext.actor.actorId,
    teamId: actorContext.tenant.teamId ?? actorContext.actionContext.teamId ?? null,
    startInstanceOAuth: async (instanceId) => {
      const result = await startOAuth({
        prisma,
        store: oauthStateStore,
        secretStore: oauthSecretStore,
        instanceId,
        actorContext,
        callbackUrl: buildOAuthCallbackUrl(request),
      })
      return result.authorizationUrl
    },
  })

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

  app.post('/api/integrations/products/:productSlug/activate', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireUserActor(actorContext, reply)) return reply

    const params = parseInput(ProductSlugParamsSchema, request.params, reply, 'params')
    if (!params) return reply

    try {
      const result = await activateExternalAgentProduct(
        prisma,
        params.productSlug,
        buildActivationContext(request, actorContext),
      )
      return createApiResponse(ExternalAgentActivationResponseSchema.parse(result))
    } catch (error) {
      if (error instanceof ExternalAgentActivationError) {
        sendApiError(reply, activationErrorStatus(error.code), error.code, error.message)
        return reply
      }
      throw error
    }
  })

  app.post('/api/integrations/products/:productSlug/deactivate', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireUserActor(actorContext, reply)) return reply

    const params = parseInput(ProductSlugParamsSchema, request.params, reply, 'params')
    if (!params) return reply

    try {
      const result = await deactivateExternalAgentProduct(prisma, params.productSlug, {
        organizationId: actorContext.tenant.organizationId,
        userId: actorContext.actor.actorId,
      })
      return createApiResponse(ExternalAgentDeactivationResponseSchema.parse(result))
    } catch (error) {
      if (error instanceof ExternalAgentActivationError) {
        sendApiError(reply, activationErrorStatus(error.code), error.code, error.message)
        return reply
      }
      throw error
    }
  })
}
