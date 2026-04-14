import { randomUUID } from 'node:crypto'
import { Prisma } from '@prisma/client'
import type { PrismaClient } from '@prisma/client'
import type { ModelConfig, ModelProvider } from '@nessie/config'
import {
  createInferenceService,
  type ModelProviderConfig,
  type ProviderMessage,
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

let agentRoutingProfileColumnPromise: Promise<boolean> | null = null

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

const getVisibleStage = (mode: RoutingMode, stages: RouteStage[]): RouteStage => {
  if (stages.length === 0) {
    throw new Error('Routing profile has no stages')
  }

  const explicitVisibleStages = stages.filter((stage) => stage.userVisible === true)
  if (explicitVisibleStages.length === 1) {
    return explicitVisibleStages[0]!
  }
  if (explicitVisibleStages.length > 1) {
    throw new Error('Routing profile has multiple user-visible stages')
  }

  if (mode === 'committee') {
    const terminal = stages.find(
      (stage) => stage.role === 'synthesizer' || stage.role === 'executor',
    )
    if (terminal) {
      return terminal
    }
  }

  if (mode === 'shadow') {
    const visible = stages.find((stage) => stage.role !== 'shadow')
    if (visible) {
      return visible
    }
  }

  return stages.at(-1) ?? stages[0]!
}

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

const parseRouteStages = (routeGraphJson: unknown): RouteStage[] => {
  if (!isObject(routeGraphJson) || !Array.isArray(routeGraphJson.stages)) {
    throw new Error('Routing profile route graph is missing stages')
  }

  return routeGraphJson.stages.map((stage, index) => {
    if (!isObject(stage)) {
      throw new Error(`Routing profile stage ${index + 1} is invalid`)
    }

    const stageId = typeof stage.id === 'string' ? stage.id : null
    const provider = typeof stage.provider === 'string' ? stage.provider : null
    const model = typeof stage.model === 'string' ? stage.model : null
    const role = typeof stage.role === 'string' ? stage.role : null

    if (!stageId || !provider || !model || !role) {
      throw new Error(`Routing profile stage ${index + 1} is missing required fields`)
    }

    return {
      id: stageId,
      inputFrom:
        Array.isArray(stage.inputFrom) && stage.inputFrom.every((value) => typeof value === 'string')
          ? stage.inputFrom
          : undefined,
      maxAttempts:
        typeof stage.maxAttempts === 'number' && Number.isInteger(stage.maxAttempts)
          ? stage.maxAttempts
          : undefined,
      model,
      provider,
      role: role as RouteStage['role'],
      toolCallingMode:
        stage.toolCallingMode === 'disabled' ||
        stage.toolCallingMode === 'native' ||
        stage.toolCallingMode === 'prompt-translated'
          ? stage.toolCallingMode
          : undefined,
      userVisible: typeof stage.userVisible === 'boolean' ? stage.userVisible : undefined,
    }
  })
}

const loadRoutingProfile = async (
  prisma: PrismaClient,
  input: {
    actorContext: AuthorizedActionContext
    organizationId: string
    routingProfileId: string
  },
): Promise<ResolvedRoute> => {
  const rows = await prisma.$queryRaw<
    Array<{
      exposure: 'standard' | 'admin_only'
      id: string
      mode: RoutingMode
      routeGraphJson: unknown
      streamPolicy: 'live' | 'buffered_judge'
    }>
  >(
    Prisma.sql`
      SELECT
        id,
        exposure::text AS exposure,
        mode::text AS mode,
        stream_policy::text AS "streamPolicy",
        route_graph_json AS "routeGraphJson"
      FROM inference_routing_profiles
      WHERE id = ${input.routingProfileId}::uuid
        AND organization_id = ${input.organizationId}::uuid
        AND enabled = true
        AND lifecycle_status = 'approved'
      LIMIT 1
    `,
  )

  const profile = rows[0]

  if (!profile) {
    throw new Error(`Routing profile ${input.routingProfileId} is not runnable`)
  }

  if (
    profile.exposure === 'admin_only' &&
    !input.actorContext.actor.roles?.includes('owner')
  ) {
    throw new Error(`Routing profile ${input.routingProfileId} is admin-only`)
  }

  const stages = parseRouteStages(profile.routeGraphJson)
  if (stages.length === 0) {
    throw new Error(`Routing profile ${input.routingProfileId} has no stages`)
  }

  return {
    mode: profile.mode,
    profileId: profile.id,
    stages,
    streamLive: profile.streamPolicy !== 'buffered_judge',
  }
}

const hasAgentRoutingProfileColumn = async (prisma: PrismaClient): Promise<boolean> => {
  if (!agentRoutingProfileColumnPromise) {
    agentRoutingProfileColumnPromise = prisma.$queryRaw<Array<{ exists: boolean }>>(
      Prisma.sql`
        SELECT EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'agents'
            AND column_name = 'routing_profile_id'
        ) AS exists
      `,
    ).then((rows) => rows[0]?.exists ?? false)
  }

  return agentRoutingProfileColumnPromise
}

const loadAgentRoutingProfileId = async (
  prisma: PrismaClient,
  agentId: string,
): Promise<string | null> => {
  if (!(await hasAgentRoutingProfileColumn(prisma))) {
    return null
  }

  const rows = await prisma.$queryRaw<Array<{ routingProfileId: string | null }>>(
    Prisma.sql`
      SELECT routing_profile_id AS "routingProfileId"
      FROM agents
      WHERE id = ${agentId}::uuid
      LIMIT 1
    `,
  )

  return rows[0]?.routingProfileId ?? null
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
        if (next.value.type === 'output_text.delta') {
          outputText += next.value.text
          if (next.value.text && input.onVisibleTextDelta) {
            await input.onVisibleTextDelta(next.value.text)
          }
        }
        next = await source.next()
      }
      invocation = next.value.invocations.at(-1)
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
      if (outputText && input.emitBufferedOutput && input.onVisibleTextDelta) {
        await input.onVisibleTextDelta(outputText)
      }
    }

    if (!outputText.trim()) {
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
      },
      invocation: enrichedInvocation,
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
      toolExecutionOwner: null,
    }
  }

  const success = await executeStage(prisma, {
    actorContext: input.actorContext,
    baseMessages: input.baseMessages,
    emitBufferedOutput: !input.route.streamLive,
    mode: input.route.mode,
    modelConfig: input.modelConfig,
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
    toolExecutionOwner: null,
  }
}

const executeFallbackMode = async (
  prisma: PrismaClient,
  input: {
    actorContext: AuthorizedActionContext
    baseMessages: ProviderMessage[]
    modelConfig: ModelConfig
    onVisibleTextDelta?: (delta: string) => Promise<void>
    organizationId: string
    route: ResolvedRoute
    routeSource: 'direct' | 'routing-profile'
  },
): Promise<MultiProviderResult> => {
  const invocations: InvocationRecord[] = []
  let lastFailure: StageExecutionFailure | null = null

  for (const [index, stage] of input.route.stages.entries()) {
    try {
      const success = await executeStage(prisma, {
        actorContext: input.actorContext,
        baseMessages: input.baseMessages,
        emitBufferedOutput: true,
        mode: input.route.mode,
        modelConfig: input.modelConfig,
        onVisibleTextDelta: input.onVisibleTextDelta,
        organizationId: input.organizationId,
        profileId: input.route.profileId,
        routeSource: input.routeSource,
        stage,
        stageIndex: index,
        stream: false,
        upstream: [],
      })

      invocations.push(success.invocation)

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
        invocations,
        requestId: input.actorContext.actionContext.requestId,
        status: 'completed',
        toolExecutionOwner: null,
      }
    } catch (error) {
      const failure = error as StageExecutionFailure
      lastFailure = failure
      if (failure.invocation) {
        invocations.push(failure.invocation)
      }
    }
  }

  return {
    correlationId: input.actorContext.actionContext.correlationId,
    failure: toFailure({
      code: 'INFERENCE_FALLBACK_EXHAUSTED',
      message: lastFailure?.message ?? 'All fallback stages failed',
      stageId: lastFailure?.stageId,
    }),
    invocations,
    requestId: input.actorContext.actionContext.requestId,
    status: 'failed',
    toolExecutionOwner: null,
  }
}

const executeCommitteeMode = async (
  prisma: PrismaClient,
  input: {
    actorContext: AuthorizedActionContext
    baseMessages: ProviderMessage[]
    modelConfig: ModelConfig
    onVisibleTextDelta?: (delta: string) => Promise<void>
    organizationId: string
    route: ResolvedRoute
    routeSource: 'direct' | 'routing-profile'
  },
): Promise<MultiProviderResult> => {
  const advisors = input.route.stages.filter((stage) => stage.role === 'advisor')
  const judges = input.route.stages.filter((stage) => stage.role === 'judge')
  const terminalStage = getVisibleStage(input.route.mode, input.route.stages)
  const invocations: InvocationRecord[] = []

  const advisorResults = await Promise.allSettled(
    advisors.map((stage, index) =>
      executeStage(prisma, {
        actorContext: input.actorContext,
        baseMessages: input.baseMessages,
        mode: input.route.mode,
        modelConfig: input.modelConfig,
        organizationId: input.organizationId,
        profileId: input.route.profileId,
        routeSource: input.routeSource,
        stage,
        stageIndex: index,
        stream: false,
        upstream: [],
      }),
    ),
  )

  const advisorOutputs: CandidateOutput[] = []
  for (const result of advisorResults) {
    if (result.status === 'fulfilled') {
      invocations.push(result.value.invocation)
      advisorOutputs.push(result.value.candidate)
      continue
    }

    const failure = result.reason as StageExecutionFailure
    if (failure.invocation) {
      invocations.push(failure.invocation)
    }
  }

  if (advisorOutputs.length === 0) {
    return {
      correlationId: input.actorContext.actionContext.correlationId,
      failure: toFailure({
        code: 'INFERENCE_COMMITTEE_NO_ADVISORS',
        message: 'All advisor stages failed',
      }),
      invocations,
      requestId: input.actorContext.actionContext.requestId,
      status: 'failed',
      toolExecutionOwner: null,
    }
  }

  const judgeResults = await Promise.allSettled(
    judges.map((stage, index) =>
      executeStage(prisma, {
        actorContext: input.actorContext,
        baseMessages: input.baseMessages,
        mode: input.route.mode,
        modelConfig: input.modelConfig,
        organizationId: input.organizationId,
        profileId: input.route.profileId,
        routeSource: input.routeSource,
        stage,
        stageIndex: advisors.length + index,
        stream: false,
        upstream: advisorOutputs,
      }),
    ),
  )

  const judgeOutputs: CandidateOutput[] = []
  for (const result of judgeResults) {
    if (result.status === 'fulfilled') {
      invocations.push(result.value.invocation)
      judgeOutputs.push(result.value.candidate)
      continue
    }

    const failure = result.reason as StageExecutionFailure
    if (failure.invocation) {
      invocations.push(failure.invocation)
    }
  }

  try {
    const terminal = await executeStage(prisma, {
      actorContext: input.actorContext,
      baseMessages: input.baseMessages,
      emitBufferedOutput: !input.route.streamLive,
      mode: input.route.mode,
      modelConfig: input.modelConfig,
      onVisibleTextDelta: input.onVisibleTextDelta,
      organizationId: input.organizationId,
      profileId: input.route.profileId,
      routeSource: input.routeSource,
      stage: terminalStage,
      stageIndex: input.route.stages.findIndex((stage) => stage.id === terminalStage.id),
      stream: input.route.streamLive,
      upstream: [...advisorOutputs, ...judgeOutputs],
    })

    invocations.push(terminal.invocation)

    return {
      answerOwner: {
        invocationId: terminal.invocation.invocationId,
        model: terminal.invocation.model,
        provider: terminal.invocation.provider,
        stageId: terminalStage.id,
        stageRole: terminalStage.role,
      },
      correlationId: input.actorContext.actionContext.correlationId,
      finalAnswer: terminal.candidate.outputText,
      invocations,
      requestId: input.actorContext.actionContext.requestId,
      status: 'completed',
      toolExecutionOwner: null,
    }
  } catch (error) {
    const failure = error as StageExecutionFailure
    if (failure.invocation) {
      invocations.push(failure.invocation)
    }

    return {
      correlationId: input.actorContext.actionContext.correlationId,
      failure: toFailure({
        code: 'INFERENCE_COMMITTEE_TERMINAL_FAILED',
        message: failure.message,
        stageId: failure.stageId,
      }),
      invocations,
      requestId: input.actorContext.actionContext.requestId,
      status: 'failed',
      toolExecutionOwner: null,
    }
  }
}

const executePipelineMode = async (
  prisma: PrismaClient,
  input: {
    actorContext: AuthorizedActionContext
    baseMessages: ProviderMessage[]
    modelConfig: ModelConfig
    onVisibleTextDelta?: (delta: string) => Promise<void>
    organizationId: string
    route: ResolvedRoute
    routeSource: 'direct' | 'routing-profile'
  },
): Promise<MultiProviderResult> => {
  const invocations: InvocationRecord[] = []
  const outputs = new Map<string, CandidateOutput>()
  const pendingStages = new Map(input.route.stages.map((stage) => [stage.id, stage]))
  const visibleStage = getVisibleStage(input.route.mode, input.route.stages)

  while (pendingStages.size > 0) {
    const readyStages = [...pendingStages.values()].filter((stage) =>
      (stage.inputFrom ?? []).every((dependencyId) => outputs.has(dependencyId)),
    )

    if (readyStages.length === 0) {
      return {
        correlationId: input.actorContext.actionContext.correlationId,
        failure: toFailure({
          code: 'INFERENCE_PIPELINE_INVALID_GRAPH',
          message: 'Pipeline stages cannot be resolved from the current graph',
        }),
        invocations,
        requestId: input.actorContext.actionContext.requestId,
        status: 'failed',
        toolExecutionOwner: null,
      }
    }

    for (const stage of readyStages) {
      pendingStages.delete(stage.id)

      try {
        const success = await executeStage(prisma, {
          actorContext: input.actorContext,
          baseMessages: input.baseMessages,
          emitBufferedOutput: stage.id === visibleStage.id && !input.route.streamLive,
          mode: input.route.mode,
          modelConfig: input.modelConfig,
          onVisibleTextDelta: stage.id === visibleStage.id ? input.onVisibleTextDelta : undefined,
          organizationId: input.organizationId,
          profileId: input.route.profileId,
          routeSource: input.routeSource,
          stage,
          stageIndex: input.route.stages.findIndex((candidate) => candidate.id === stage.id),
          stream: stage.id === visibleStage.id && input.route.streamLive,
          upstream: (stage.inputFrom ?? []).map((dependencyId) => outputs.get(dependencyId)!),
        })

        invocations.push(success.invocation)
        outputs.set(stage.id, success.candidate)
      } catch (error) {
        const failure = error as StageExecutionFailure
        if (failure.invocation) {
          invocations.push(failure.invocation)
        }

        return {
          correlationId: input.actorContext.actionContext.correlationId,
          failure: toFailure({
            code: 'INFERENCE_PIPELINE_STAGE_FAILED',
            message: failure.message,
            stageId: failure.stageId,
          }),
          invocations,
          requestId: input.actorContext.actionContext.requestId,
          status: 'failed',
          toolExecutionOwner: null,
        }
      }
    }
  }

  const finalOutput = outputs.get(visibleStage.id)
  if (!finalOutput) {
    return {
      correlationId: input.actorContext.actionContext.correlationId,
      failure: toFailure({
        code: 'INFERENCE_PIPELINE_NO_VISIBLE_OUTPUT',
        message: `Visible stage ${visibleStage.id} produced no output`,
        stageId: visibleStage.id,
      }),
      invocations,
      requestId: input.actorContext.actionContext.requestId,
      status: 'failed',
      toolExecutionOwner: null,
    }
  }

  const invocation = invocations.find(
    (record) => record.invocationId === finalOutput.invocationIds[0],
  )

  return {
    answerOwner: invocation
      ? {
          invocationId: invocation.invocationId,
          model: invocation.model,
          provider: invocation.provider,
          stageId: visibleStage.id,
          stageRole: visibleStage.role,
        }
      : undefined,
    correlationId: input.actorContext.actionContext.correlationId,
    finalAnswer: finalOutput.outputText,
    invocations,
    requestId: input.actorContext.actionContext.requestId,
    status: 'completed',
    toolExecutionOwner: null,
  }
}

const executeShadowMode = async (
  prisma: PrismaClient,
  input: {
    actorContext: AuthorizedActionContext
    baseMessages: ProviderMessage[]
    modelConfig: ModelConfig
    onVisibleTextDelta?: (delta: string) => Promise<void>
    organizationId: string
    route: ResolvedRoute
    routeSource: 'direct' | 'routing-profile'
  },
): Promise<MultiProviderResult> => {
  const visibleStage = getVisibleStage(input.route.mode, input.route.stages)
  const shadowStages = input.route.stages.filter((stage) => stage.id !== visibleStage.id)
  const invocations: InvocationRecord[] = []

  const shadowPromise = Promise.allSettled(
    shadowStages.map((stage, index) =>
      executeStage(prisma, {
        actorContext: input.actorContext,
        baseMessages: input.baseMessages,
        mode: input.route.mode,
        modelConfig: input.modelConfig,
        organizationId: input.organizationId,
        profileId: input.route.profileId,
        routeSource: input.routeSource,
        stage,
        stageIndex: index + 1,
        stream: false,
        upstream: [],
      }),
    ),
  )

  try {
    const visibleResult = await executeStage(prisma, {
      actorContext: input.actorContext,
      baseMessages: input.baseMessages,
      emitBufferedOutput: !input.route.streamLive,
      mode: input.route.mode,
      modelConfig: input.modelConfig,
      onVisibleTextDelta: input.onVisibleTextDelta,
      organizationId: input.organizationId,
      profileId: input.route.profileId,
      routeSource: input.routeSource,
      stage: visibleStage,
      stageIndex: input.route.stages.findIndex((stage) => stage.id === visibleStage.id),
      stream: input.route.streamLive,
      upstream: [],
    })

    invocations.push(visibleResult.invocation)

    const shadowResults = await shadowPromise
    for (const result of shadowResults) {
      if (result.status === 'fulfilled') {
        invocations.push(result.value.invocation)
        continue
      }

      const failure = result.reason as StageExecutionFailure
      if (failure.invocation) {
        invocations.push(failure.invocation)
      }
    }

    return {
      answerOwner: {
        invocationId: visibleResult.invocation.invocationId,
        model: visibleResult.invocation.model,
        provider: visibleResult.invocation.provider,
        stageId: visibleStage.id,
        stageRole: visibleStage.role,
      },
      correlationId: input.actorContext.actionContext.correlationId,
      finalAnswer: visibleResult.candidate.outputText,
      invocations,
      requestId: input.actorContext.actionContext.requestId,
      status: 'completed',
      toolExecutionOwner: null,
    }
  } catch (error) {
    const failure = error as StageExecutionFailure
    if (failure.invocation) {
      invocations.push(failure.invocation)
    }

    const shadowResults = await shadowPromise
    for (const result of shadowResults) {
      if (result.status === 'fulfilled') {
        invocations.push(result.value.invocation)
        continue
      }

      const shadowFailure = result.reason as StageExecutionFailure
      if (shadowFailure.invocation) {
        invocations.push(shadowFailure.invocation)
      }
    }

    return {
      correlationId: input.actorContext.actionContext.correlationId,
      failure: toFailure({
        code: 'INFERENCE_SHADOW_VISIBLE_STAGE_FAILED',
        message: failure.message,
        stageId: failure.stageId,
      }),
      invocations,
      requestId: input.actorContext.actionContext.requestId,
      status: 'failed',
      toolExecutionOwner: null,
    }
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
  return prisma.modelPricingProfile.findFirst({
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
}

export const runInferenceGraph = async (
  prisma: PrismaClient,
  input: RunInferenceGraphInput,
): Promise<MultiProviderResult> => {
  const routingProfileId =
    input.agent.routingProfileId ?? (await loadAgentRoutingProfileId(prisma, input.agent.id))

  const route = routingProfileId
    ? await loadRoutingProfile(prisma, {
        actorContext: input.actorContext,
        organizationId: input.organizationId,
        routingProfileId,
      })
    : buildDirectRoute(
        {
          model: input.agent.model,
          provider: input.agent.provider,
        },
        input.modelConfig,
      )

  const routeSource: 'direct' | 'routing-profile' = routingProfileId
    ? 'routing-profile'
    : 'direct'

  switch (route.mode) {
    case 'single':
      return executeSingleMode(prisma, {
        actorContext: input.actorContext,
        baseMessages: input.baseMessages,
        modelConfig: input.modelConfig,
        onVisibleTextDelta: input.onVisibleTextDelta,
        organizationId: input.organizationId,
        route,
        routeSource,
        toolChoice: input.toolChoice,
        tools: input.tools,
      })
    case 'fallback':
      return executeFallbackMode(prisma, {
        actorContext: input.actorContext,
        baseMessages: input.baseMessages,
        modelConfig: input.modelConfig,
        onVisibleTextDelta: input.onVisibleTextDelta,
        organizationId: input.organizationId,
        route,
        routeSource,
      })
    case 'committee':
      return executeCommitteeMode(prisma, {
        actorContext: input.actorContext,
        baseMessages: input.baseMessages,
        modelConfig: input.modelConfig,
        onVisibleTextDelta: input.onVisibleTextDelta,
        organizationId: input.organizationId,
        route,
        routeSource,
      })
    case 'pipeline':
      return executePipelineMode(prisma, {
        actorContext: input.actorContext,
        baseMessages: input.baseMessages,
        modelConfig: input.modelConfig,
        onVisibleTextDelta: input.onVisibleTextDelta,
        organizationId: input.organizationId,
        route,
        routeSource,
      })
    case 'shadow':
      return executeShadowMode(prisma, {
        actorContext: input.actorContext,
        baseMessages: input.baseMessages,
        modelConfig: input.modelConfig,
        onVisibleTextDelta: input.onVisibleTextDelta,
        organizationId: input.organizationId,
        route,
        routeSource,
      })
    default:
      throw new Error(`Unsupported routing mode: ${route.mode}`)
  }
}

const toPrismaOperationType = (
  operationType: InvocationRecord['operationType'],
): 'chat' | 'completion' | 'embedding' | 'translation' | 'reasoning' | 'tool_translation' | 'other' => {
  if (operationType === 'tool-translation') {
    return 'tool_translation'
  }

  return operationType
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
