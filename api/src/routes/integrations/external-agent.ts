import type { FastifyInstance, FastifyRequest } from 'fastify'
import {
  createPgOAuthStateStore,
  createPgSecretStore,
  startOAuth,
} from '@nessie/mcp-manage'
import { z } from 'zod'

import { createApiResponse, parseInput, sendApiError } from '../../lib/api.js'
import {
  activateExternalAgentProduct,
  deactivateExternalAgentProduct,
  ExternalAgentActivationError,
  EXTERNAL_AGENT_ACTIVATION_ERROR_CODES,
  type ExternalAgentActivationContext,
} from '../../services/external-agent-activation.js'
import { buildOAuthCallbackUrl } from '../mcp/oauth.js'
import type { RouteDeps } from '../types.js'
import { ProductSlugParamsSchema } from './route-schemas.js'

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

/**
 * External-agent product activation (DeepSignal integration plan §5). Turning a
 * catalog product "on" provisions its external-agent channel and, when the
 * upstream needs a sign-in, kicks off the shared MCP OAuth flow so authorization
 * runs through the same encrypted store, pg-backed state, and
 * `/api/mcp/oauth/callback` as every other connector.
 */
export const registerExternalAgentProductRoutes = (
  app: FastifyInstance,
  deps: RouteDeps,
): void => {
  const { prisma, requireActorContext, requireUserActor, authSecret } = deps

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
