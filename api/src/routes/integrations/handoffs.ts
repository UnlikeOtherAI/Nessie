import type { FastifyInstance, FastifyReply } from 'fastify'
import {
  BuildMeProjectHandoffRequestSchema,
  DeepTestReviewHandoffRequestSchema,
  DeepWaterResearchLaunchRequestSchema,
} from '@nessie/schemas'

import {
  ChannelRecordSchema,
  ThreadMessageRecordSchema,
  ThreadRecordSchema,
} from '../../contracts.js'
import { createApiResponse, parseInput, sendApiError } from '../../lib/api.js'
import { createPersonalAssistantIntegrationHandoff } from '../../services/integration-handoffs.js'
import {
  attachDeepWaterResearchHandoff,
  createDeepWaterResearchRun,
  markDeepWaterResearchRunFailed,
} from '../../services/integration-runs.js'
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

    const products = await listIntegratedProducts(prisma, {
      organizationId: actorContext.tenant.organizationId,
      teamId,
      userId: actorContext.actor.actorId,
    })
    const product = products.find((candidate) => candidate.slug === 'deep-water')
    if (!product) {
      sendApiError(reply, 404, 'INTEGRATION_PRODUCT_NOT_FOUND', 'Integration product not found')
      return reply
    }
    if (!product.teamEnablement?.enabled) {
      sendApiError(reply, 409, 'DEEP_WATER_TEAM_DISABLED', 'Deep Water is not enabled for this team')
      return reply
    }
    const mcpInstallation = product.mcpInstallation
    if (!mcpInstallation || mcpInstallation.lifecycleState !== 'active') {
      sendApiError(reply, 409, 'DEEP_WATER_MCP_INACTIVE', 'Deep Water MCP is not active for this team')
      return reply
    }

    const run = await createDeepWaterResearchRun(prisma, {
      connectorId: mcpInstallation.id,
      input: body,
      organizationId: actorContext.tenant.organizationId,
      requestedByUserId: actorContext.actor.actorId,
      teamId,
    })

    let handoff: IntegrationHandoff
    try {
      handoff = await createPersonalAssistantIntegrationHandoff(deps, {
        actorContext,
        content: buildDeepWaterLaunchMessage(body),
        metadata: ({ channelId }) => buildDeepWaterLaunchMetadata(body, {
          channelId,
          connectorId: mcpInstallation.id,
          productSlug: product.slug,
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

    const attachedRun = await attachDeepWaterResearchHandoff(prisma, {
      channelId: handoff.channel.id,
      messageId: handoff.message.id,
      organizationId: actorContext.tenant.organizationId,
      runId: run.id,
      threadId: handoff.thread.id,
    })

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
