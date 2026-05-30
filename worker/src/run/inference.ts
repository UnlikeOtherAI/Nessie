import { randomUUID } from 'node:crypto'
import { Prisma } from '@prisma/client'
import type { PrismaClient } from '@prisma/client'
import type { ModelConfig, ModelProvider } from '@nessie/config'
import {
  createInferenceService,
  type ModelProviderConfig,
  type ProviderMessage,
  type ProviderToolCall,
  type ToolSchemaDescriptor,
} from '@nessie/runtime'
import type {
  AuthorizedActionContext,
  CandidateOutput,
  InvocationRecord,
  MultiProviderFailure,
  MultiProviderResult,
  OperationType,
  RouteStage,
  RoutingMode,
  StepMetadataStep,
} from '@nessie/schemas'

const DEFAULT_MODEL_BY_PROVIDER: Record<ModelProvider, string> = {
  minimax: 'MiniMax-M2.5',
  kimi: 'kimi-for-coding',
  openai: 'gpt-5-mini',
}

type RunnableProvider = ModelProvider | 'openai-compatible'

type RunInferenceGraphInput = {
  actorContext: AuthorizedActionContext
  agent: {
    id: string
    model: string | null
    provider: string | null
    routingProfileId: string | null
  }
  baseMessages: ProviderMessage[]
  modelConfig: ModelConfig
  onVisibleReasoningDelta?: (delta: string) => Promise<void>
  onVisibleTextDelta?: (delta: string) => Promise<void>
  organizationId: string
  tools?: ToolSchemaDescriptor[]
  toolChoice?: 'auto' | 'none' | 'required'
}

type PersistInvocationLedgerInput = {
  actorContext: AuthorizedActionContext
  agentId: string
  invocations: InvocationRecord[]
}

type ResolvedRoute = {
  mode: RoutingMode
  profileId?: string
  stages: RouteStage[]
  streamLive: boolean
}

type StageExecutionSuccess = {
  candidate: CandidateOutput
  invocation: InvocationRecord
  toolCalls: ProviderToolCall[]
}

type ResolvedProviderConfig = {
  apiKey: string
  baseUrl?: string
  connectorKind?: 'compiled' | 'openai-compatible'
  model: string
  providerKey: string
}

type InvocationPricingProfile = {
  id: string
  source: 'provider_default' | 'org_override' | 'team_override' | 'manual'
  currency: string
  inputPerMillion: number | null
  outputPerMillion: number | null
  cachedInputPerMillion: number | null
  cachedOutputPerMillion: number | null
  cacheReadPerMillion: number | null
  cacheWritePerMillion: number | null
}

type StageExecutionFailure = Error & {
  invocation?: InvocationRecord
  stageId?: string
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const toErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : 'Inference execution failed unexpectedly'

const createStageFailure = (
  message: string,
  input?: { invocation?: InvocationRecord; stageId?: string },
): StageExecutionFailure => {
  const error = new Error(message) as StageExecutionFailure
  error.invocation = input?.invocation
  error.stageId = input?.stageId
  return error
}

const resolveRuntimeProvider = (providerKey: string): RunnableProvider | null => {
  const normalized = providerKey.trim().toLowerCase()
  if (normalized === 'openai') {
    return 'openai'
  }
  if (normalized === 'openai-compatible') {
    return 'openai-compatible'
  }
  if (normalized === 'minimax') {
    return 'minimax'
  }
  if (normalized === 'kimi') {
    return 'kimi'
  }
  return null
}

const resolveModelName = (provider: ModelProvider, requestedModel?: string | null): string =>
  requestedModel?.trim() || DEFAULT_MODEL_BY_PROVIDER[provider]

const resolveLegacyApiKey = (provider: ModelProvider, modelConfig: ModelConfig): string => {
  if (provider === 'openai') {
    return (
      process.env.OPENAI_CHAT_API_KEY ??
      process.env.OPENAI_API_KEY ??
      (modelConfig.provider === 'openai' ? modelConfig.apiKey : undefined) ??
      ''
    )
  }

  if (provider === 'kimi') {
    return (
      process.env.KIMI_API_KEY ??
      (modelConfig.provider === 'kimi' ? modelConfig.apiKey : undefined) ??
      ''
    )
  }

  return process.env.MINIMAX_API_KEY ?? (modelConfig.provider === 'minimax' ? modelConfig.apiKey : undefined) ?? ''
}

const resolveBoundApiKey = (authSecretRef: string | null | undefined): string =>
  authSecretRef ? process.env[authSecretRef] ?? '' : ''

const buildVisibleStageMessages = (
  baseMessages: ProviderMessage[],
  upstream: CandidateOutput[],
): ProviderMessage[] => {
  if (upstream.length === 0) {
    return baseMessages
  }

  const upstreamContext = upstream
    .map((candidate) => {
      const lines = [
        `Stage: ${candidate.stageId}`,
        `Role: ${candidate.stageRole}`,
      ]

      if (candidate.outputText.trim()) {
        lines.push('Output:')
        lines.push(candidate.outputText.trim())
      }

      return lines.join('\n')
    })
    .join('\n\n')

  return [
    ...baseMessages,
    {
      content: [
        'Upstream stage outputs are available for this step.',
        'Use them as intermediate context when producing the final answer.',
        upstreamContext,
      ].join('\n\n'),
      role: 'system' as const,
    },
  ]
}

const resolveStepMetadata = (
  mode: RoutingMode,
  stage: RouteStage,
  stageIndex: number,
): StepMetadataStep => {
  if (stage.role === 'advisor') {
    return 'advisor'
  }
  if (stage.role === 'synthesizer') {
    return 'synthesizer'
  }
  if (stage.role === 'judge') {
    return 'judge'
  }
  if (stage.role === 'shadow') {
    return 'shadow'
  }
  if (mode === 'fallback' && stageIndex > 0) {
    return 'fallback'
  }
  return 'primary'
}

const resolveOperationType = (stage: RouteStage): OperationType =>
  stage.role === 'judge' ? 'reasoning' : 'chat'

const toFailure = (
  input: {
    code: string
    message: string
    stageId?: string
  },
): MultiProviderFailure => ({
  code: input.code,
  message: input.message,
  stageId: input.stageId,
})

const buildDirectRoute = (
  input: {
    model: string | null
    provider: string | null
  },
  modelConfig: ModelConfig,
): ResolvedRoute => {
  const providerKey = input.provider?.trim() || modelConfig.provider
  const runtimeProvider = resolveRuntimeProvider(providerKey)
  const model =
    runtimeProvider && runtimeProvider !== 'openai-compatible'
      ? resolveModelName(runtimeProvider, input.model ?? modelConfig.modelName)
      : input.model?.trim() || modelConfig.modelName

  if (!model) {
    throw new Error(`Direct route ${providerKey} is missing a model`)
  }

  return {
    mode: 'single',
    stages: [
      {
        id: 'direct',
        model,
        provider: providerKey,
        role: 'executor',
        userVisible: true,
      },
    ],
    streamLive: true,
  }
}

const resolveStageProviderConfig = async (
  prisma: PrismaClient,
  input: {
    modelConfig: ModelConfig
    organizationId: string
    providerKey: string
    requestedModel: string
    routeSource: 'direct' | 'routing-profile'
  },
): Promise<ResolvedProviderConfig> => {
  const runtimeProvider = resolveRuntimeProvider(input.providerKey)
  const providerRows = await prisma.$queryRaw<
    Array<{
      authSecretRef: string | null
      baseUrl: string | null
      connectorKind: 'compiled' | 'openai_compatible'
      id: string
    }>
  >(
    Prisma.sql`
      SELECT
        p.id,
        p.connector_kind::text AS "connectorKind",
        p.base_url AS "baseUrl",
        b.auth_secret_ref AS "authSecretRef"
      FROM inference_providers p
      LEFT JOIN inference_credential_bindings b
        ON b.id = p.active_credential_binding_id
      WHERE p.organization_id = ${input.organizationId}::uuid
        AND p.provider_key = ${input.providerKey}
        AND p.enabled = true
        AND p.lifecycle_status = 'approved'
      LIMIT 1
    `,
  )

  const providerRecord = providerRows[0]
  if (input.routeSource === 'routing-profile' && !providerRecord) {
    throw new Error(`Routing profile provider ${input.providerKey} is not runnable`)
  }

  if (providerRecord) {
    const modelRows = await prisma.$queryRaw<Array<{ id: string }>>(
      Prisma.sql`
        SELECT id
        FROM inference_models
        WHERE organization_id = ${input.organizationId}::uuid
          AND provider_id = ${providerRecord.id}::uuid
          AND model = ${input.requestedModel}
          AND enabled = true
          AND lifecycle_status = 'approved'
        LIMIT 1
      `,
    )

    const modelRecord = modelRows[0]

    if (!modelRecord && input.routeSource === 'routing-profile') {
      throw new Error(
        `Routing profile model ${input.requestedModel} for provider ${input.providerKey} is not runnable`,
      )
    }
  }

  const connectorKind =
    providerRecord?.connectorKind === 'openai_compatible'
      ? 'openai-compatible'
      : 'compiled'

  const apiKey =
    resolveBoundApiKey(providerRecord?.authSecretRef) ||
    (runtimeProvider && runtimeProvider !== 'openai-compatible'
      ? resolveLegacyApiKey(runtimeProvider, input.modelConfig)
      : '')

  if (!apiKey) {
    throw new Error(`Missing API key for provider ${input.providerKey}`)
  }

  return {
    apiKey,
    baseUrl: providerRecord?.baseUrl ?? undefined,
    connectorKind,
    model: runtimeProvider && runtimeProvider !== 'openai-compatible'
      ? resolveModelName(runtimeProvider, input.requestedModel)
      : input.requestedModel,
    providerKey: input.providerKey,
  }
}

const executeStage = async (
  prisma: PrismaClient,
  input: {
    actorContext: AuthorizedActionContext
    baseMessages: ProviderMessage[]
    emitBufferedOutput?: boolean
    mode: RoutingMode
    modelConfig: ModelConfig
    onVisibleReasoningDelta?: (delta: string) => Promise<void>
    onVisibleTextDelta?: (delta: string) => Promise<void>
    organizationId: string
    profileId?: string
    routeSource: 'direct' | 'routing-profile'
    stage: RouteStage
    stageIndex: number
    stream: boolean
    toolChoice?: 'auto' | 'none' | 'required'
    tools?: ToolSchemaDescriptor[]
    upstream: CandidateOutput[]
  },
): Promise<StageExecutionSuccess> => {
  const startedAt = Date.now()
  const requestId = input.actorContext.actionContext.requestId
  const correlationId = input.actorContext.actionContext.correlationId
  const step = resolveStepMetadata(input.mode, input.stage, input.stageIndex)
  const operationType = resolveOperationType(input.stage)
  const messages = buildVisibleStageMessages(input.baseMessages, input.upstream)

  let providerConfig: ResolvedProviderConfig | null = null
  let service: ReturnType<typeof createInferenceService> | null = null

  try {
    providerConfig = await resolveStageProviderConfig(prisma, {
      modelConfig: input.modelConfig,
      organizationId: input.organizationId,
      providerKey: input.stage.provider,
      requestedModel: input.stage.model,
      routeSource: input.routeSource,
    })

    const runtimeProvider =
      resolveRuntimeProvider(providerConfig.providerKey)
      ?? (providerConfig.connectorKind === 'openai-compatible' ? 'openai-compatible' : null)
    if (!runtimeProvider) {
      throw new Error(`Provider ${providerConfig.providerKey} is not runnable`)
    }

    const serviceConfig: ModelProviderConfig = {
      apiKey: providerConfig.apiKey,
      baseUrl: providerConfig.baseUrl,
      modelName: providerConfig.model,
      provider: runtimeProvider,
    }
    service = createInferenceService(serviceConfig)

    let outputText = ''
    let invocation: InvocationRecord | undefined
    let toolCalls: ProviderToolCall[] = []
    if (input.stream) {
      const source = service.stream?.({
        actorContext: input.actorContext,
        maxOutputTokens: input.modelConfig.maxTokens,
        messages,
        model: providerConfig.model,
        requestId,
        temperature: input.modelConfig.temperature,
        tools: input.tools,
        toolChoice: input.toolChoice,
      })
      if (!source) {
        throw new Error(`Provider ${providerConfig.providerKey} does not support streaming`)
      }

      let next = await source.next()
      while (!next.done) {
        if (next.value.type === 'reasoning_text.delta') {
          if (next.value.text && input.onVisibleReasoningDelta) {
            await input.onVisibleReasoningDelta(next.value.text)
          }
        }
        if (next.value.type === 'output_text.delta') {
          outputText += next.value.text
          if (next.value.text && input.onVisibleTextDelta) {
            await input.onVisibleTextDelta(next.value.text)
          }
        }
        next = await source.next()
      }
      outputText = next.value.outputText
      invocation = next.value.invocations.at(-1)
      toolCalls = next.value.toolCalls
    } else {
      const result = await service.run({
        actorContext: input.actorContext,
        maxOutputTokens: input.modelConfig.maxTokens,
        messages,
        model: providerConfig.model,
        requestId,
        temperature: input.modelConfig.temperature,
        tools: input.tools,
        toolChoice: input.toolChoice,
      })
      outputText = result.outputText
      invocation = result.invocations.at(-1)
      toolCalls = result.toolCalls
      if (outputText && input.emitBufferedOutput && input.onVisibleTextDelta) {
        await input.onVisibleTextDelta(outputText)
      }
    }

    if (!outputText.trim() && toolCalls.length === 0) {
      throw new Error(`Stage ${input.stage.id} produced no content`)
    }
    if (!invocation) {
      throw new Error(`Stage ${input.stage.id} produced no invocation record`)
    }

    const enrichedInvocation: InvocationRecord = {
      ...invocation,
      correlationId: correlationId ?? invocation.correlationId,
      latencyMs: Math.max(invocation.latencyMs, Date.now() - startedAt),
      metadata: {
        ...(invocation.metadata ?? {}),
        profileId: input.profileId,
        routeSource: input.routeSource,
        routingMode: input.mode,
        stageId: input.stage.id,
        stageRole: input.stage.role,
        step,
      },
      operationType,
      provider: providerConfig.providerKey,
      requestId,
    }

    return {
      candidate: {
        finishReason: enrichedInvocation.finishReason,
        invocationIds: [enrichedInvocation.invocationId],
        metadata: enrichedInvocation.metadata,
        outputText,
        stageId: input.stage.id,
        stageRole: input.stage.role,
        toolCalls:
          toolCalls.length > 0
            ? toolCalls.map((toolCall) => ({
                arguments: toolCall.arguments,
                toolName: toolCall.toolName,
              }))
            : undefined,
      },
      invocation: enrichedInvocation,
      toolCalls,
    }
  } catch (error) {
    const maybeInvocation =
      isObject(error) && 'invocation' in error && isObject(error.invocation)
        ? (error.invocation as InvocationRecord)
        : undefined

    const invocation: InvocationRecord | undefined = providerConfig
      ? {
          ...(maybeInvocation ?? {
            finishReason: 'error',
            invocationId: randomUUID(),
            latencyMs: Math.max(0, Date.now() - startedAt),
            model: providerConfig.model,
            operationType,
            provider: providerConfig.providerKey,
            requestId,
            usage: {},
          }),
          correlationId: correlationId ?? maybeInvocation?.correlationId,
          latencyMs: Math.max(
            maybeInvocation?.latencyMs ?? 0,
            Math.max(0, Date.now() - startedAt),
          ),
          metadata: {
            ...(maybeInvocation?.metadata ?? {}),
            errorMessage: toErrorMessage(error),
            profileId: input.profileId,
            routeSource: input.routeSource,
            routingMode: input.mode,
            stageId: input.stage.id,
            stageRole: input.stage.role,
            step,
          },
          operationType,
          provider: providerConfig.providerKey,
          requestId,
        }
      : undefined

    throw createStageFailure(toErrorMessage(error), {
      invocation,
      stageId: input.stage.id,
    })
  } finally {
    service?.close()
  }
}

const executeSingleMode = async (
  prisma: PrismaClient,
  input: {
    actorContext: AuthorizedActionContext
    baseMessages: ProviderMessage[]
    modelConfig: ModelConfig
    onVisibleReasoningDelta?: (delta: string) => Promise<void>
    onVisibleTextDelta?: (delta: string) => Promise<void>
    organizationId: string
    route: ResolvedRoute
    routeSource: 'direct' | 'routing-profile'
    tools?: ToolSchemaDescriptor[]
    toolChoice?: 'auto' | 'none' | 'required'
  },
): Promise<MultiProviderResult> => {
  const stage = input.route.stages[0]
  if (!stage) {
    return {
      correlationId: input.actorContext.actionContext.correlationId,
      failure: toFailure({
        code: 'INFERENCE_SINGLE_NO_STAGE',
        message: 'Single route has no stage',
      }),
      invocations: [],
      requestId: input.actorContext.actionContext.requestId,
      status: 'failed',
      toolCalls: [],
      toolExecutionOwner: null,
    }
  }

  const success = await executeStage(prisma, {
    actorContext: input.actorContext,
    baseMessages: input.baseMessages,
    emitBufferedOutput: !input.route.streamLive,
    mode: input.route.mode,
    modelConfig: input.modelConfig,
    onVisibleReasoningDelta: input.onVisibleReasoningDelta,
    onVisibleTextDelta: input.onVisibleTextDelta,
    organizationId: input.organizationId,
    profileId: input.route.profileId,
    routeSource: input.routeSource,
    stage,
    stageIndex: 0,
    stream: input.route.streamLive,
    toolChoice: input.toolChoice,
    tools: input.tools,
    upstream: [],
  })

  return {
    answerOwner: {
      invocationId: success.invocation.invocationId,
      model: success.invocation.model,
      provider: success.invocation.provider,
      stageId: stage.id,
      stageRole: stage.role,
    },
    correlationId: input.actorContext.actionContext.correlationId,
    finalAnswer: success.candidate.outputText,
    invocations: [success.invocation],
    requestId: input.actorContext.actionContext.requestId,
    status: 'completed',
    toolCalls: success.toolCalls,
    toolExecutionOwner:
      success.toolCalls.length > 0
        ? {
            invocationId: success.invocation.invocationId,
            model: success.invocation.model,
            provider: success.invocation.provider,
            stageId: stage.id,
          }
        : null,
  }
}

const calculateEstimatedCost = (
  usage: InvocationRecord['usage'],
  pricingProfile: InvocationPricingProfile | null,
): number | null => {
  if (!pricingProfile) {
    return null
  }

  let amount = 0
  if (usage.inputTokens && pricingProfile.inputPerMillion) {
    amount += (usage.inputTokens / 1_000_000) * pricingProfile.inputPerMillion
  }
  if (usage.outputTokens && pricingProfile.outputPerMillion) {
    amount += (usage.outputTokens / 1_000_000) * pricingProfile.outputPerMillion
  }
  if (usage.cachedInputTokens && pricingProfile.cachedInputPerMillion) {
    amount += (usage.cachedInputTokens / 1_000_000) * pricingProfile.cachedInputPerMillion
  }
  if (usage.cachedOutputTokens && pricingProfile.cachedOutputPerMillion) {
    amount += (usage.cachedOutputTokens / 1_000_000) * pricingProfile.cachedOutputPerMillion
  }
  if (usage.cacheReadTokens && pricingProfile.cacheReadPerMillion) {
    amount += (usage.cacheReadTokens / 1_000_000) * pricingProfile.cacheReadPerMillion
  }
  if (usage.cacheWriteTokens && pricingProfile.cacheWritePerMillion) {
    amount += (usage.cacheWriteTokens / 1_000_000) * pricingProfile.cacheWritePerMillion
  }

  return amount
}

const findPricingProfile = async (
  prisma: PrismaClient,
  organizationId: string,
  provider: string,
  model: string,
): Promise<InvocationPricingProfile | null> => {
  const row = await prisma.modelPricingProfile.findFirst({
    where: {
      AND: [{ OR: [{ effectiveTo: null }, { effectiveTo: { gt: new Date() } }] }],
      organizationId,
      OR: [{ modelPattern: model }, { modelPattern: '*' }],
      provider,
    },
    orderBy: { modelPattern: 'desc' },
    select: {
      cacheReadPerMillion: true,
      cacheWritePerMillion: true,
      cachedInputPerMillion: true,
      cachedOutputPerMillion: true,
      currency: true,
      id: true,
      inputPerMillion: true,
      outputPerMillion: true,
      source: true,
    },
  })
  if (!row) {
    return null
  }
  // ModelPricingProfile per-million columns are Prisma Decimal; the cost math
  // works in plain numbers, so normalize here.
  const toNumber = (value: { toNumber: () => number } | null): number | null =>
    value === null ? null : value.toNumber()
  return {
    id: row.id,
    source: row.source,
    currency: row.currency,
    inputPerMillion: toNumber(row.inputPerMillion),
    outputPerMillion: toNumber(row.outputPerMillion),
    cachedInputPerMillion: toNumber(row.cachedInputPerMillion),
    cachedOutputPerMillion: toNumber(row.cachedOutputPerMillion),
    cacheReadPerMillion: toNumber(row.cacheReadPerMillion),
    cacheWritePerMillion: toNumber(row.cacheWritePerMillion),
  }
}

export const runInferenceGraph = async (
  prisma: PrismaClient,
  input: RunInferenceGraphInput,
): Promise<MultiProviderResult> => {
  // Inference always runs a single direct stage: the agent's provider/model,
  // executed via `executeSingleMode`. Multi-stage routing profiles
  // (fallback/committee/pipeline/shadow) were never reachable — agents never
  // persist a routing profile id — and have been removed.
  const route = buildDirectRoute(
    {
      model: input.agent.model,
      provider: input.agent.provider,
    },
    input.modelConfig,
  )

  return executeSingleMode(prisma, {
    actorContext: input.actorContext,
    baseMessages: input.baseMessages,
    modelConfig: input.modelConfig,
    onVisibleReasoningDelta: input.onVisibleReasoningDelta,
    onVisibleTextDelta: input.onVisibleTextDelta,
    organizationId: input.organizationId,
    route,
    routeSource: 'direct',
    toolChoice: input.toolChoice,
    tools: input.tools,
  })
}

const toPrismaOperationType = (
  operationType: InvocationRecord['operationType'],
): 'chat' | 'completion' | 'embedding' | 'translation' | 'reasoning' | 'tool_translation' | 'other' => {
  if (operationType === 'tool-translation') {
    return 'tool_translation'
  }

  return operationType
}

// Resolve the canonical inference-catalog ids for the denormalized provider/model
// strings the ledger records. The stored `provider` is the provider_key and
// `model` is the resolved model name (see executeStage), so this join is exact.
// Returns nulls for runs that used a provider/model not in the catalog (e.g. the
// legacy env-key fallback path) — the strings remain the durable record.
const resolveProviderModelIds = async (
  prisma: PrismaClient,
  organizationId: string,
  provider: string,
  model: string,
): Promise<{ modelId: string | null; providerId: string | null }> => {
  const rows = await prisma.$queryRaw<Array<{ modelId: string | null; providerId: string | null }>>(
    Prisma.sql`
      SELECT p.id AS "providerId", m.id AS "modelId"
      FROM inference_providers p
      LEFT JOIN inference_models m
        ON m.provider_id = p.id
        AND m.organization_id = p.organization_id
        AND m.model = ${model}
      WHERE p.organization_id = ${organizationId}::uuid
        AND p.provider_key = ${provider}
      LIMIT 1
    `,
  )

  return { modelId: rows[0]?.modelId ?? null, providerId: rows[0]?.providerId ?? null }
}

export const persistInvocationLedgerEvents = async (
  prisma: PrismaClient,
  input: PersistInvocationLedgerInput,
): Promise<void> => {
  const organizationId = input.actorContext.tenant.organizationId
  const projectId = input.actorContext.tenant.projectId ?? null
  const teamId = input.actorContext.tenant.teamId ?? null
  const channelId = input.actorContext.actionContext.channelId ?? null
  const threadId = input.actorContext.actionContext.threadId ?? null
  const sessionId = input.actorContext.actionContext.sessionId ?? null
  const taskId = input.actorContext.actionContext.taskId ?? null
  const requestId = input.actorContext.actionContext.requestId
  const correlationId = input.actorContext.actionContext.correlationId ?? null
  const actorId = input.actorContext.actor.actorId

  for (const invocation of input.invocations) {
    const pricingProfile = await findPricingProfile(
      prisma,
      organizationId,
      invocation.provider,
      invocation.model,
    )

    const estimatedCostAmount = calculateEstimatedCost(invocation.usage, pricingProfile)
    const { modelId, providerId } = await resolveProviderModelIds(
      prisma,
      organizationId,
      invocation.provider,
      invocation.model,
    )

    await prisma.tokenLedgerEvent.create({
      data: {
        actorId,
        agentId: input.agentId,
        cacheReadTokens: invocation.usage.cacheReadTokens ?? null,
        cacheWriteTokens: invocation.usage.cacheWriteTokens ?? null,
        cachedInputTokens: invocation.usage.cachedInputTokens ?? null,
        cachedOutputTokens: invocation.usage.cachedOutputTokens ?? null,
        channelId,
        correlationId,
        estimatedCostAmount,
        estimatedCostCurrency: pricingProfile?.currency ?? null,
        inputTokens: invocation.usage.inputTokens ?? null,
        metadata: {
          invocationId: invocation.invocationId,
          latencyMs: invocation.latencyMs,
          ...(invocation.metadata ?? {}),
        },
        model: invocation.model,
        occurredAt: new Date(),
        operationType: toPrismaOperationType(invocation.operationType),
        organizationId,
        outputTokens: invocation.usage.outputTokens ?? null,
        pricingCurrency: pricingProfile?.currency ?? null,
        pricingInputPerM: pricingProfile?.inputPerMillion ?? null,
        pricingOutputPerM: pricingProfile?.outputPerMillion ?? null,
        pricingProfileId: pricingProfile?.id ?? null,
        pricingSource: pricingProfile?.source ?? null,
        projectId,
        provider: invocation.provider,
        providerId,
        modelId,
        providerCostAmount: invocation.providerReportedCost?.amount ?? null,
        providerCostCurrency: invocation.providerReportedCost?.currency ?? null,
        requestId,
        sessionId,
        taskId,
        teamId,
        threadId,
        totalTokens: invocation.usage.totalTokens ?? null,
      },
    })
  }
}
