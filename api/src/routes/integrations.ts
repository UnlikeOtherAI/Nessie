import { Prisma } from '@prisma/client'
import type { FastifyInstance } from 'fastify'
import {
  DeepWaterResearchLaunchRequestSchema,
  IntegratedProductResponseSchema,
  IntegrationUiCardSchema,
  IntegrationPluginManifestSchema,
  parseChannelId,
  parseThreadId,
  parseUserId,
  SetProductTeamEnablementRequestSchema,
  withActionContext,
} from '@nessie/schemas'
import { z } from 'zod'

import {
  ChannelRecordSchema,
  ThreadMessageRecordSchema,
  ThreadRecordSchema,
} from '../contracts.js'
import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import { enqueueOrchestrateDecide } from '../queue/pgqueue.js'
import { getIntegrationPluginManifest } from '../services/integration-plugin-manifests.js'
import { listIntegratedProducts, setProductTeamEnablement } from '../services/integrations.js'
import { mapMessageRecord, messageInclude } from '../services/messages.js'
import { ensurePersonalAssistantBootstrap } from '../services/personal-assistant.js'
import type { RouteDeps } from './types.js'

const ProductSlugParamsSchema = z.object({
  productSlug: z.string().min(1),
})

type DeepWaterLaunchInput = {
  artifactDestination: 'knowledge_draft' | 'chat_only'
  chapterDepth: 'brief' | 'standard' | 'detailed' | 'exhaustive'
  depth: 'light' | 'standard' | 'deep' | 'heavy' | 'thesis' | 'dissertation'
  outputLanguage: string
  outputTier: 'summary' | 'full'
  query: string
  recency: 'any' | 'day' | 'week' | 'month' | 'year'
  searchQuality: 'standard' | 'premium'
  searchesPerPillar: number
  sections: number
  title?: string
}

const normalizeDeepWaterLaunchInput = (
  input: Partial<DeepWaterLaunchInput> & { query: string },
): DeepWaterLaunchInput => ({
  artifactDestination: input.artifactDestination ?? 'knowledge_draft',
  chapterDepth: input.chapterDepth ?? 'standard',
  depth: input.depth ?? 'standard',
  outputLanguage: input.outputLanguage ?? 'en',
  outputTier: input.outputTier ?? 'full',
  query: input.query,
  recency: input.recency ?? 'any',
  searchQuality: input.searchQuality ?? 'standard',
  searchesPerPillar: input.searchesPerPillar ?? 4,
  sections: input.sections ?? 8,
  title: input.title,
})

export const registerIntegrationRoutes = (app: FastifyInstance, deps: RouteDeps): void => {
  const {
    buildChannelRealtimeScopes,
    isPersonalAssistantChannelType,
    loadPersonalAssistantState,
    prisma,
    realtimeHub,
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
    if (product.mcpInstallation?.lifecycleState !== 'active') {
      sendApiError(reply, 409, 'DEEP_WATER_MCP_INACTIVE', 'Deep Water MCP is not active for this team')
      return reply
    }

    await ensurePersonalAssistantBootstrap(prisma, {
      organizationId: actorContext.tenant.organizationId,
      teamId,
      userId: actorContext.actor.actorId,
    })
    const paState = await loadPersonalAssistantState(actorContext)
    if (!paState?.agent || !paState.channel || !paState.thread) {
      sendApiError(reply, 500, 'PERSONAL_ASSISTANT_UNAVAILABLE', 'Personal Assistant is unavailable')
      return reply
    }

    const agent = await prisma.agent.findUnique({
      where: { id: paState.agent.id },
      select: { id: true, name: true, role: true, systemPrompt: true },
    })
    if (!agent) {
      sendApiError(reply, 500, 'PERSONAL_ASSISTANT_UNAVAILABLE', 'Personal Assistant agent is unavailable')
      return reply
    }

    const content = buildDeepWaterLaunchMessage(body)
    const metadata = buildDeepWaterLaunchMetadata(body, {
      channelId: paState.channel.id,
      connectorId: product.mcpInstallation.id,
    })
    const message = await prisma.message.create({
      data: {
        content,
        metadata: metadata as Prisma.InputJsonValue,
        role: 'user',
        threadId: paState.thread.id,
        userId: actorContext.actor.actorId,
      },
      include: messageInclude,
    })

    await realtimeHub.publishWs(
      buildChannelRealtimeScopes({
        channelId: paState.channel.id,
        organizationId: actorContext.tenant.organizationId,
        systemChannelType: paState.channel.systemChannelType,
      }),
      {
        data: {
          agentId: undefined,
          authorUserId: parseUserId(actorContext.actor.actorId),
          channelId: parseChannelId(paState.channel.id),
          contentPreview: content.slice(0, 200),
          messageId: message.id,
          role: message.role,
          threadId: parseThreadId(paState.thread.id),
        },
        event: 'message.new',
      },
    )

    const orchestrationActorContext = isPersonalAssistantChannelType(
      paState.channel.systemChannelType,
    )
      ? withActionContext(actorContext, {
          effectiveUserId: parseUserId(actorContext.actor.actorId),
        })
      : actorContext
    await enqueueOrchestrateDecide(
      prisma,
      {
        actorContext: orchestrationActorContext,
        channelAgents: [agent],
        channelId: parseChannelId(paState.channel.id),
        content,
        messageId: message.id,
        role: message.role,
        threadId: parseThreadId(paState.thread.id),
      },
      `orchestrate:${message.id}`,
    )

    return reply.code(202).send(createApiResponse({
      channel: ChannelRecordSchema.parse(paState.channel),
      message: ThreadMessageRecordSchema.parse(mapMessageRecord(message)),
      thread: ThreadRecordSchema.parse(paState.thread),
    }))
  })
}

const buildDeepWaterLaunchMessage = (
  input: DeepWaterLaunchInput,
): string => {
  const title = input.title?.trim()
  const destination =
    input.artifactDestination === 'knowledge_draft'
      ? 'Draft the completed report and source summary into Knowledge, then request publication.'
      : 'Summarize the result in this chat without creating a Knowledge draft.'

  return [
    'Run Deep Water research through the approved MCP connector.',
    '',
    title ? `Title: ${title}` : null,
    `Depth: ${input.depth}`,
    `Chapter depth: ${input.chapterDepth}`,
    `Output tier: ${input.outputTier}`,
    `Output language: ${input.outputLanguage}`,
    `Search quality: ${input.searchQuality}`,
    `Recency: ${input.recency}`,
    `Sections: ${input.sections}`,
    `Searches per pillar: ${input.searchesPerPillar}`,
    '',
    'Query:',
    input.query,
    '',
    'Use mcp_research_create with these settings, then poll with mcp_research_get until the job reaches a terminal state.',
    'When reporting back, include the Deep Water run id, status, source count, and any usage/cost fields returned by the tool.',
    destination,
  ].filter((line): line is string => line !== null).join('\n')
}

const buildDeepWaterLaunchMetadata = (
  input: DeepWaterLaunchInput,
  context: { channelId: string; connectorId: string },
): Record<string, unknown> => ({
  integrationLaunch: {
    artifactDestination: input.artifactDestination,
    connectorId: context.connectorId,
    productSlug: 'deep-water',
    requestedAt: new Date().toISOString(),
  },
  mentions: { agentIds: [], broadcast: null, userIds: [] },
  uiCards: [
    IntegrationUiCardSchema.parse({
      actions: [
        { href: `/channels/${context.channelId}`, label: 'Open chat', variant: 'primary' },
      ],
      fields: [
        { label: 'Depth', value: input.depth },
        { label: 'Output', value: input.outputTier },
        {
          label: 'Destination',
          value: input.artifactDestination === 'knowledge_draft' ? 'Knowledge draft' : 'Chat',
        },
        { label: 'Connector', value: 'MCP active' },
      ],
      kind: 'deep_research',
      productSlug: 'deep-water',
      status: 'queued',
      summary: 'Personal Assistant will launch this through Deep Water MCP and report progress here.',
      title: input.title?.trim() || 'Deep Water research',
    }),
  ],
})
