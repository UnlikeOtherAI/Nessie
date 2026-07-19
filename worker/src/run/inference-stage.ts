import { createHash, randomUUID } from 'node:crypto'
import type { PrismaClient } from '@prisma/client'
import type { ModelConfig } from '@nessie/config'
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
  OperationType,
  RouteStage,
  RoutingMode,
  StepMetadataStep,
} from '@nessie/schemas'
import {
  resolveRuntimeProvider,
  resolveStageProviderConfig,
  type ResolvedProviderConfig,
} from './inference-provider.js'
import type { ProviderRequestHeadersResolver } from './inference-identity.js'

// Stable cache key from the request's cacheable prefix (model + tool set + the
// system anchor message). Identical whenever the prefix is identical, so the
// provider routes repeated turns/runs of the same agent to the same prompt
// cache. Derived from content, so it needs no agent/run id threaded in.
export const buildPromptCacheKey = (
  model: string,
  baseMessages: ProviderMessage[],
  tools: ToolSchemaDescriptor[] | undefined,
): string | undefined => {
  const anchor = baseMessages[0]
  if (!anchor) return undefined
  const toolNames = (tools ?? []).map((tool) => tool.toolName).sort().join(',')
  return createHash('sha256')
    .update(`${model}\u0000${toolNames}\u0000${JSON.stringify(anchor)}`)
    .digest('hex')
    .slice(0, 40)
}

export type StageExecutionSuccess = {
  candidate: CandidateOutput
  invocation: InvocationRecord
  toolCalls: ProviderToolCall[]
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

export const executeStage = async (
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
    requestHeadersForProvider?: ProviderRequestHeadersResolver
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
  const promptCacheKey = buildPromptCacheKey(
    input.stage.model ?? '',
    input.baseMessages,
    input.tools,
  )

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
    const requestHeaders =
      await input.requestHeadersForProvider?.(providerConfig)

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
      serviceId: providerConfig.providerKey,
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
        promptCacheKey,
        requestId,
        requestHeaders,
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
        promptCacheKey,
        requestId,
        requestHeaders,
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
