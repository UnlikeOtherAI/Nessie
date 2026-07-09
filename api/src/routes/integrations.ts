import type { FastifyInstance } from 'fastify'
import {
  BuildMeProjectHandoffRequestSchema,
  DeepTestReviewHandoffRequestSchema,
  DeepWaterResearchLaunchRequestSchema,
  IntegratedProductResponseSchema,
  IntegrationUiCardSchema,
  IntegrationPluginManifestSchema,
  SetProductTeamEnablementRequestSchema,
} from '@nessie/schemas'
import { z } from 'zod'

import {
  ChannelRecordSchema,
  ThreadMessageRecordSchema,
  ThreadRecordSchema,
} from '../contracts.js'
import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import { createPersonalAssistantIntegrationHandoff } from '../services/integration-handoffs.js'
import { getIntegrationPluginManifest } from '../services/integration-plugin-manifests.js'
import { listIntegratedProducts, setProductTeamEnablement } from '../services/integrations.js'
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

type DeepTestReviewHandoffInput = {
  artifactPolicy: 'share_safe_report' | 'external_link_only'
  depth: 'shallow' | 'standard' | 'deep' | 'overnight'
  runner: 'local_mcp' | 'private_runner'
}

type BuildMeProjectHandoffInput = {
  contextScope: 'active_project' | 'active_team'
  intent: 'project_definition' | 'development_workspace' | 'board_source_discovery'
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

const normalizeDeepTestReviewHandoffInput = (
  input: Partial<DeepTestReviewHandoffInput>,
): DeepTestReviewHandoffInput => ({
  artifactPolicy: input.artifactPolicy ?? 'share_safe_report',
  depth: input.depth ?? 'standard',
  runner: input.runner ?? 'local_mcp',
})

const normalizeBuildMeProjectHandoffInput = (
  input: Partial<BuildMeProjectHandoffInput>,
): BuildMeProjectHandoffInput => ({
  contextScope: input.contextScope ?? 'active_project',
  intent: input.intent ?? 'project_definition',
})

export const registerIntegrationRoutes = (app: FastifyInstance, deps: RouteDeps): void => {
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

    let handoff: Awaited<ReturnType<typeof createPersonalAssistantIntegrationHandoff>>
    try {
      handoff = await createPersonalAssistantIntegrationHandoff(deps, {
        actorContext,
        content: buildDeepWaterLaunchMessage(body),
        metadata: ({ channelId }) => buildDeepWaterLaunchMetadata(body, {
          channelId,
          connectorId: mcpInstallation.id,
          productSlug: product.slug,
        }),
        teamId,
      })
    } catch {
      sendApiError(reply, 500, 'PERSONAL_ASSISTANT_UNAVAILABLE', 'Personal Assistant is unavailable')
      return reply
    }

    return reply.code(202).send(createApiResponse({
      channel: ChannelRecordSchema.parse(handoff.channel),
      message: ThreadMessageRecordSchema.parse(handoff.message),
      thread: ThreadRecordSchema.parse(handoff.thread),
    }))
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

    let handoff: Awaited<ReturnType<typeof createPersonalAssistantIntegrationHandoff>>
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

    return reply.code(202).send(createApiResponse({
      channel: ChannelRecordSchema.parse(handoff.channel),
      message: ThreadMessageRecordSchema.parse(handoff.message),
      thread: ThreadRecordSchema.parse(handoff.thread),
    }))
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

    let handoff: Awaited<ReturnType<typeof createPersonalAssistantIntegrationHandoff>>
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

    return reply.code(202).send(createApiResponse({
      channel: ChannelRecordSchema.parse(handoff.channel),
      message: ThreadMessageRecordSchema.parse(handoff.message),
      thread: ThreadRecordSchema.parse(handoff.thread),
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
  context: { channelId: string; connectorId: string; productSlug: string },
): Record<string, unknown> => ({
  integrationLaunch: {
    artifactDestination: input.artifactDestination,
    connectorId: context.connectorId,
    productSlug: context.productSlug,
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

const buildDeepTestReviewHandoffMessage = (
  input: DeepTestReviewHandoffInput,
): string => {
  const artifactPolicy =
    input.artifactPolicy === 'share_safe_report'
      ? 'Import only a share-safe, target-neutral report into Knowledge if the local runner returns one.'
      : 'Keep artifacts in DeepTest and link out; do not import reports into Nessie.'

  return [
    'Prepare a DeepTest security review through the approved local MCP connector.',
    '',
    `Depth: ${input.depth}`,
    `Runner: ${input.runner}`,
    `Artifact policy: ${input.artifactPolicy}`,
    '',
    'Privacy boundary:',
    '- Do not ask the user to paste target URLs, source code, PR diffs, findings, prompts, secrets, or raw reports into Nessie.',
    '- The user must configure the target inside DeepTest or its local runner.',
    '- Use mcp_deeptest_review only after the local runner and approved tool grant are available.',
    '- If a report is returned, summarize only status, controlled counts, neutral next steps, and share-safe artifacts.',
    artifactPolicy,
  ].join('\n')
}

const buildDeepTestReviewHandoffMetadata = (
  input: DeepTestReviewHandoffInput,
  context: { channelId: string; connectorId: string; launchUrl: string | null; productSlug: string },
): Record<string, unknown> => ({
  integrationLaunch: {
    artifactPolicy: input.artifactPolicy,
    connectorId: context.connectorId,
    productSlug: context.productSlug,
    requestedAt: new Date().toISOString(),
  },
  mentions: { agentIds: [], broadcast: null, userIds: [] },
  uiCards: [
    IntegrationUiCardSchema.parse({
      actions: [
        { href: `/channels/${context.channelId}`, label: 'Open chat', variant: 'primary' },
        ...(context.launchUrl
          ? [{ href: context.launchUrl, label: 'Open DeepTest', variant: 'secondary' as const }]
          : []),
      ],
      fields: [
        { label: 'Depth', value: input.depth },
        {
          label: 'Import',
          value: input.artifactPolicy === 'share_safe_report' ? 'Share-safe only' : 'Link only',
        },
        { label: 'Runner', value: input.runner === 'local_mcp' ? 'Local MCP' : 'Private runner' },
        { label: 'Boundary', value: 'No target material in Nessie' },
      ],
      kind: 'security_review',
      productSlug: 'deeptest',
      status: 'queued',
      summary: 'Personal Assistant will use DeepTest MCP while keeping target material local.',
      title: 'DeepTest security review',
    }),
  ],
})

const buildBuildMeProjectHandoffMessage = (
  input: BuildMeProjectHandoffInput,
  launchUrl: string | null,
): string => {
  const intent = input.intent.replace(/_/g, ' ')
  const scope =
    input.contextScope === 'active_project'
      ? 'Use only the active Nessie project/team as context.'
      : 'Use only the active Nessie team as context.'

  return [
    'Prepare a buildme.live project handoff.',
    '',
    `Intent: ${intent}`,
    `Context scope: ${input.contextScope}`,
    launchUrl ? `Launch URL: ${launchUrl}` : null,
    '',
    'Boundary:',
    '- Use UOA SSO link-out for the BuildMe workspace.',
    '- Do not create, sync, or mutate Nessie project-board columns from BuildMe yet.',
    '- Do not ask the user to paste BuildMe board payloads, card lists, column mappings, credentials, or workspace files into Nessie.',
    '- If the user asks for native board pairing, explain that it needs the BuildMe board API/MCP contract first.',
    scope,
  ].filter((line): line is string => line !== null).join('\n')
}

const buildBuildMeProjectHandoffMetadata = (
  input: BuildMeProjectHandoffInput,
  context: { channelId: string; launchUrl: string | null; productSlug: string },
): Record<string, unknown> => ({
  integrationLaunch: {
    contextScope: input.contextScope,
    intent: input.intent,
    productSlug: context.productSlug,
    requestedAt: new Date().toISOString(),
  },
  mentions: { agentIds: [], broadcast: null, userIds: [] },
  uiCards: [
    IntegrationUiCardSchema.parse({
      actions: [
        { href: `/channels/${context.channelId}`, label: 'Open chat', variant: 'primary' },
        ...(context.launchUrl
          ? [{ href: context.launchUrl, label: 'Open buildme.live', variant: 'secondary' as const }]
          : []),
      ],
      fields: [
        { label: 'Intent', value: input.intent.replace(/_/g, ' ') },
        {
          label: 'Context',
          value: input.contextScope === 'active_project' ? 'Active project' : 'Active team',
        },
        { label: 'SSO', value: 'UOA linked' },
        { label: 'Board API', value: 'Contract pending' },
      ],
      kind: 'project_board',
      productSlug: 'buildme',
      status: 'needs_setup',
      summary: 'Personal Assistant will prepare a link-out handoff and keep board sync blocked.',
      title: 'buildme.live project handoff',
    }),
  ],
})
