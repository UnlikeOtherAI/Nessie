import type { FastifyInstance, FastifyReply } from 'fastify'
import {
  BuildMeProjectHandoffRequestSchema,
  DeepTestReviewHandoffRequestSchema,
  DeepWaterResearchLaunchRequestSchema,
} from '@nessie/schemas'
import {
  attachDeepWaterResearchHandoff,
  createDeepWaterResearchRun,
  markDeepWaterResearchRunFailed,
} from '@nessie/runtime'

import { ChannelRecordSchema } from '../../contracts/team.js'
import { ThreadMessageRecordSchema, ThreadRecordSchema } from '../../contracts/messaging.js'
import { createApiResponse, parseInput, sendApiError } from '../../lib/api.js'
import {
  DeepWaterLaunchAuthorizationError,
  runWithAuthorizedDeepWaterLaunch,
} from '../../services/deepwater-launch-authorization.js'
import { createPersonalAssistantIntegrationHandoff } from '../../services/integration-handoffs.js'
import { listIntegratedProducts } from '../../services/integrations.js'
import type { RouteDeps } from '../types.js'
import {
  buildBuildMeProjectHandoffMessage,
  buildBuildMeProjectHandoffMetadata,
  buildDeepTestReviewHandoffMessage,
  buildDeepTestReviewHandoffMetadata,
  buildDeepWaterLaunchMessage,
  buildDeepWaterLaunchMetadata,
} from './handoff-builders.js'
import {
  normalizeBuildMeProjectHandoffInput,
  normalizeDeepTestReviewHandoffInput,
  normalizeDeepWaterLaunchInput,
  ProductSlugParamsSchema,
} from './route-schemas.js'

type IntegrationHandoff = Awaited<ReturnType<typeof createPersonalAssistantIntegrationHandoff>>

const sendHandoffResponse = (
  reply: FastifyReply,
  handoff: IntegrationHandoff,
  extra?: Record<string, unknown>,
) =>
  reply.code(202).send(createApiResponse({
    channel: ChannelRecordSchema.parse(handoff.channel),
    message: ThreadMessageRecordSchema.parse(handoff.message),
    thread: ThreadRecordSchema.parse(handoff.thread),
    ...extra,
  }))

export const registerIntegrationHandoffRoutes = (
  app: FastifyInstance,
  deps: RouteDeps,
): void => {
  const { prisma, requireActorContext, requireUserActor } = deps

  app.post('/api/integrations/products/:productSlug/research-launch', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireUserActor(actorContext, reply)) return reply

    const params = parseInput(ProductSlugParamsSchema, request.params, reply, 'params')
    if (!params) return reply
    if (params.productSlug !== 'deep-water') {
      sendApiError(reply, 404, 'INTEGRATION_PRODUCT_NOT_FOUND', 'Integration product not found')
      return reply
    }

    const parsedBody = parseInput(DeepWaterResearchLaunchRequestSchema, request.body, reply)
    if (!parsedBody) return reply
    const body = normalizeDeepWaterLaunchInput(parsedBody)

    const teamId = actorContext.tenant.teamId ?? actorContext.actionContext.teamId
    if (!teamId) {
      sendApiError(reply, 400, 'TEAM_CONTEXT_REQUIRED', 'A team context is required')
      return reply
    }

    let authorizedLaunch
    try {
      authorizedLaunch = await runWithAuthorizedDeepWaterLaunch(
        prisma,
        {
          organizationId: actorContext.tenant.organizationId,
          teamId,
        },
        async (tx, connectorId) => ({
          connectorId,
          run: await createDeepWaterResearchRun(
            tx as unknown as typeof prisma,
            {
              connectorId,
              input: body,
              organizationId: actorContext.tenant.organizationId,
              requestedByUserId: actorContext.actor.actorId,
              teamId,
            },
          ),
        }),
      )
    } catch (error) {
      if (error instanceof DeepWaterLaunchAuthorizationError) {
        sendApiError(reply, 409, error.code, error.message)
        return reply
      }
      throw error
    }
    const { connectorId, run } = authorizedLaunch

    let handoff: IntegrationHandoff
    let attachedRun
    try {
      handoff = await createPersonalAssistantIntegrationHandoff(deps, {
        actorContext,
        beforeEnqueue: async (tx, context) => {
          attachedRun = await attachDeepWaterResearchHandoff(
            tx as unknown as typeof prisma,
            {
              ...context,
              organizationId: actorContext.tenant.organizationId,
              runId: run.id,
            },
          )
        },
        content: buildDeepWaterLaunchMessage(body, { runId: run.id }),
        metadata: ({ channelId }) => buildDeepWaterLaunchMetadata(body, {
          channelId,
          connectorId,
          productSlug: 'deep-water',
          runId: run.id,
        }),
        teamId,
      })
    } catch {
      await markDeepWaterResearchRunFailed(prisma, {
        organizationId: actorContext.tenant.organizationId,
        runId: run.id,
      })
      sendApiError(reply, 500, 'PERSONAL_ASSISTANT_UNAVAILABLE', 'Personal Assistant is unavailable')
      return reply
    }
    if (!attachedRun) {
      await markDeepWaterResearchRunFailed(prisma, {
        organizationId: actorContext.tenant.organizationId,
        runId: run.id,
      })
      sendApiError(reply, 500, 'DEEP_WATER_HANDOFF_ATTACH_FAILED', 'Research handoff failed')
      return reply
    }

    return sendHandoffResponse(reply, handoff, { run: attachedRun })
  })

  app.post('/api/integrations/products/:productSlug/security-handoff', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireUserActor(actorContext, reply)) return reply

    const params = parseInput(ProductSlugParamsSchema, request.params, reply, 'params')
    if (!params) return reply
    if (params.productSlug !== 'deeptest') {
      sendApiError(reply, 404, 'INTEGRATION_PRODUCT_NOT_FOUND', 'Integration product not found')
      return reply
    }

    const parsedBody = parseInput(DeepTestReviewHandoffRequestSchema, request.body, reply)
    if (!parsedBody) return reply
    const body = normalizeDeepTestReviewHandoffInput(parsedBody)

    const teamId = actorContext.tenant.teamId ?? actorContext.actionContext.teamId
    if (!teamId) {
      sendApiError(reply, 400, 'TEAM_CONTEXT_REQUIRED', 'A team context is required')
      return reply
    }

    const products = await listIntegratedProducts(prisma, {
      organizationId: actorContext.tenant.organizationId,
      teamId,
      userId: actorContext.actor.actorId,
    })
    const product = products.find((candidate) => candidate.slug === 'deeptest')
    if (!product) {
      sendApiError(reply, 404, 'INTEGRATION_PRODUCT_NOT_FOUND', 'Integration product not found')
      return reply
    }
    if (!product.teamEnablement?.enabled) {
      sendApiError(reply, 409, 'DEEPTEST_TEAM_DISABLED', 'DeepTest is not enabled for this team')
      return reply
    }
    const mcpInstallation = product.mcpInstallation
    if (!mcpInstallation || mcpInstallation.lifecycleState !== 'active') {
      sendApiError(reply, 409, 'DEEPTEST_MCP_INACTIVE', 'DeepTest MCP is not active for this team')
      return reply
    }

    let handoff: IntegrationHandoff
    try {
      handoff = await createPersonalAssistantIntegrationHandoff(deps, {
        actorContext,
        content: buildDeepTestReviewHandoffMessage(body),
        metadata: ({ channelId }) => buildDeepTestReviewHandoffMetadata(body, {
          channelId,
          connectorId: mcpInstallation.id,
          launchUrl: product.launchUrl,
          productSlug: product.slug,
        }),
        teamId,
      })
    } catch {
      sendApiError(reply, 500, 'PERSONAL_ASSISTANT_UNAVAILABLE', 'Personal Assistant is unavailable')
      return reply
    }

    return sendHandoffResponse(reply, handoff)
  })

  app.post('/api/integrations/products/:productSlug/project-handoff', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireUserActor(actorContext, reply)) return reply

    const params = parseInput(ProductSlugParamsSchema, request.params, reply, 'params')
    if (!params) return reply
    if (params.productSlug !== 'buildme') {
      sendApiError(reply, 404, 'INTEGRATION_PRODUCT_NOT_FOUND', 'Integration product not found')
      return reply
    }

    const parsedBody = parseInput(BuildMeProjectHandoffRequestSchema, request.body, reply)
    if (!parsedBody) return reply
    const body = normalizeBuildMeProjectHandoffInput(parsedBody)

    const teamId = actorContext.tenant.teamId ?? actorContext.actionContext.teamId
    if (!teamId) {
      sendApiError(reply, 400, 'TEAM_CONTEXT_REQUIRED', 'A team context is required')
      return reply
    }

    const products = await listIntegratedProducts(prisma, {
      organizationId: actorContext.tenant.organizationId,
      teamId,
      userId: actorContext.actor.actorId,
    })
    const product = products.find((candidate) => candidate.slug === 'buildme')
    if (!product) {
      sendApiError(reply, 404, 'INTEGRATION_PRODUCT_NOT_FOUND', 'Integration product not found')
      return reply
    }
    if (!product.teamEnablement?.enabled) {
      sendApiError(reply, 409, 'BUILDME_TEAM_DISABLED', 'buildme.live is not enabled for this team')
      return reply
    }
    if (product.accountLink?.status !== 'linked') {
      sendApiError(reply, 409, 'BUILDME_ACCOUNT_UNLINKED', 'buildme.live account link is unavailable')
      return reply
    }

    let handoff: IntegrationHandoff
    try {
      handoff = await createPersonalAssistantIntegrationHandoff(deps, {
        actorContext,
        content: buildBuildMeProjectHandoffMessage(body, product.launchUrl),
        metadata: ({ channelId }) => buildBuildMeProjectHandoffMetadata(body, {
          channelId,
          launchUrl: product.launchUrl,
          productSlug: product.slug,
        }),
        teamId,
      })
    } catch {
      sendApiError(reply, 500, 'PERSONAL_ASSISTANT_UNAVAILABLE', 'Personal Assistant is unavailable')
      return reply
    }

    return sendHandoffResponse(reply, handoff)
  })
}
