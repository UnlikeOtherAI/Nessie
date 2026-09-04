import { randomUUID } from 'node:crypto'
import type { PrismaClient } from '@prisma/client'
import type { ModelConfig } from '@nessie/config'
import {
  buildPromptCacheKey,
  isLedgerEndpoint,
  createInferenceService,
  providerFailureDetails,
  type ModelProviderConfig,
  type ProviderMessage,
  type ProviderToolCall,
  type ToolSchemaDescriptor,
} from '@nessie/runtime'
import {
  createSecretRedactingStream,
  redactDetectedSecrets,
  type AuthorizedActionContext,
  type CandidateOutput,
  type InvocationRecord,
  type OperationType,
  type ProviderReasoningEffort,
  type RouteStage,
  type RoutingMode,
  type StepMetadataStep,
} from '@nessie/schemas'
import {
  resolveRuntimeProvider,
  resolveStageProviderConfig,
  type ResolvedProviderConfig,
  type StageSubscriptionBinding,
} from './inference-provider.js'
import type { ProviderRequestHeadersResolver } from './inference-identity.js'
import { InferenceAbortedError } from './inference-abort.js'
import { sanitizeProviderToolCalls } from './tool-util.js'

// The cache-key derivation lives in @nessie/runtime beside the connectors
// that consume it, shared with the model client's utility calls. The anchor it
// hashes (`baseMessages[0]`) must stay the byte-stable system block
// `buildModelPrompt` puts first — never a message carrying per-run content.
export { buildPromptCacheKey }

export type StageExecutionSuccess = {
  candidate: CandidateOutput
  invocation: InvocationRecord
  toolCalls: ProviderToolCall[]
}

type StageExecutionFailure = Error & {
  creditRefusal?: 'ledger'
  invocation?: InvocationRecord
  providerCode?: string
  stageId?: string
  statusCode?: number
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const toErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : 'Inference execution failed unexpectedly'

const createStageFailure = (
  message: string,
  input?: {
    invocation?: InvocationRecord
    providerFailure?: {
      creditRefusal?: 'ledger'
      providerCode?: string
      statusCode?: number
    }
    stageId?: string
  },
): StageExecutionFailure => {
  const error = new Error(message) as StageExecutionFailure
  error.creditRefusal = input?.providerFailure?.creditRefusal
  error.invocation = input?.invocation
  error.providerCode = input?.providerFailure?.providerCode
  error.stageId = input?.stageId
  error.statusCode = input?.providerFailure?.statusCode
  return error
}

const buildVisibleStageMessages = (
  baseMessages: ProviderMessage[],
  upstream: CandidateOutput[],
): ProviderMessage[] => {
  const redactMessages = (messages: ProviderMessage[]): ProviderMessage[] =>
    messages.map((message) => {
      if (typeof message.content !== 'string') return message
      return { ...message, content: redactDetectedSecrets(message.content) } as ProviderMessage
    })

  if (upstream.length === 0) return redactMessages(baseMessages)

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

  return redactMessages([
    ...baseMessages,
    {
      content: [
        'Upstream stage outputs are available for this step.',
        'Use them as intermediate context when producing the final answer.',
        upstreamContext,
      ].join('\n\n'),
      role: 'system' as const,
    },
  ])
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
    // Fired once per inference attempt, before any delta. `callInferenceWithRetry`
    // re-issues the same iteration, and tool-call indexes restart at 0 on every
    // attempt, so a consumer correlating fragments must reset on this boundary
    // rather than accumulate across the run.
    onInferenceAttempt?: (attempt: { invocationId: string }) => void
    // Synchronous by contract: a document stream must never make the provider
    // read loop wait on Postgres. Consumers enqueue and return.
    onToolCallDelta?: (event: {
      id: string
      index: number
      invocationId: string
      text: string
      toolName: string
    }) => void
    organizationId: string
    profileId?: string
    reasoningEffort?: ProviderReasoningEffort
    requestHeadersForProvider?: ProviderRequestHeadersResolver
    routeSource: 'direct' | 'routing-profile'
    subscription?: StageSubscriptionBinding | null
    // Aborts the in-flight provider request. Used by cooperative cancellation
    // while a document is streaming, where waiting for the turn to end would
    // mean watching the rest of a document the user already stopped.
    signal?: AbortSignal
    stage: RouteStage
    stageIndex: number
    stream: boolean
    // Raises this call's output ceiling above `modelConfig.maxTokens`. A
    // document is emitted as tool-call arguments in one completion, so the
    // ordinary per-call default would truncate it mid-write.
    maxOutputTokensOverride?: number
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
      subscription: input.subscription ?? null,
    })
    const requestHeaders =
      await input.requestHeadersForProvider?.(providerConfig)

    const runtimeProvider =
      resolveRuntimeProvider(providerConfig.providerKey)
      // Ledger's token-scoped model catalog supplies arbitrary service ids.
      // Every option we expose to agent configuration is constrained to Ledger
      // `chat/completions`, so its generic OpenAI-compatible connector is the
      // correct transport for services without a compiled adapter.
      ?? (
        providerConfig.connectorKind === 'openai-compatible'
        || isLedgerEndpoint(providerConfig.baseUrl)
          ? 'openai-compatible'
          : null
      )
    if (!runtimeProvider) {
      throw new Error(`Provider ${providerConfig.providerKey} is not runnable`)
    }

    const serviceConfig: ModelProviderConfig = {
      apiKey: providerConfig.apiKey,
      baseUrl: providerConfig.baseUrl,
      ...(providerConfig.extraHeaders
        ? { extraHeaders: providerConfig.extraHeaders }
        : {}),
      modelName: providerConfig.model,
      provider: runtimeProvider,
      serviceId: providerConfig.providerKey,
    }
    service = createInferenceService(serviceConfig)

    let outputText = ''
    let invocation: InvocationRecord | undefined
    let toolCalls: ProviderToolCall[] = []
    // One attempt = one id. Retries re-enter this function, so this is exactly
    // the boundary a fragment consumer must reset on.
    const invocationId = randomUUID()
    const maxOutputTokens = input.maxOutputTokensOverride ?? input.modelConfig.maxTokens
    input.onInferenceAttempt?.({ invocationId })
    if (input.stream) {
      const reasoningStream = createSecretRedactingStream()
      const textStream = createSecretRedactingStream()
      const source = service.stream?.({
        actorContext: input.actorContext,
        maxOutputTokens,
        messages,
        model: providerConfig.model,
        promptCacheKey,
        reasoningEffort: input.reasoningEffort,
        requestId,
        requestHeaders,
        signal: input.signal,
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
            const safe = reasoningStream.push(next.value.text)
            if (safe) await input.onVisibleReasoningDelta(safe)
          }
        }
        if (next.value.type === 'output_text.delta') {
          outputText += next.value.text
          if (next.value.text && input.onVisibleTextDelta) {
            const safe = textStream.push(next.value.text)
            if (safe) await input.onVisibleTextDelta(safe)
          }
        }
        next = await source.next()
      }
      if (input.onVisibleReasoningDelta) {
        const safeReasoningTail = reasoningStream.finish()
        if (safeReasoningTail) await input.onVisibleReasoningDelta(safeReasoningTail)
      }
      if (input.onVisibleTextDelta) {
        const safeTextTail = textStream.finish()
        if (safeTextTail) await input.onVisibleTextDelta(safeTextTail)
      }
      outputText = redactDetectedSecrets(next.value.outputText)
      invocation = next.value.invocations.at(-1)
      toolCalls = sanitizeProviderToolCalls(next.value.toolCalls)
    } else {
      const result = await service.run({
        actorContext: input.actorContext,
        maxOutputTokens,
        messages,
        model: providerConfig.model,
        promptCacheKey,
        reasoningEffort: input.reasoningEffort,
        requestId,
        requestHeaders,
        signal: input.signal,
        temperature: input.modelConfig.temperature,
        tools: input.tools,
        toolChoice: input.toolChoice,
      })
      outputText = redactDetectedSecrets(result.outputText)
      invocation = result.invocations.at(-1)
      toolCalls = sanitizeProviderToolCalls(result.toolCalls)
      if (outputText && input.emitBufferedOutput && input.onVisibleTextDelta) {
        await input.onVisibleTextDelta(outputText)
      }
    }

    // Tool arguments cannot be streamed safely: credentials and JSON strings
    // may span arbitrary provider deltas. Replay the complete sanitized call
    // once, preserving the document recorder's byte-match invariant while no
    // raw fragment reaches its live or durable lanes.
    if (input.onToolCallDelta) {
      for (const [index, toolCall] of toolCalls.entries()) {
        input.onToolCallDelta({
          id: toolCall.toolCallId,
          index,
          invocationId,
          text: JSON.stringify(toolCall.arguments),
          toolName: toolCall.toolName,
        })
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
    // Convert here, where the signal is still in scope. Below this point the
    // error is re-wrapped and only its message survives, which is not enough to
    // tell a deliberate cancellation from a transient provider failure.
    if (input.signal?.aborted) {
      throw new InferenceAbortedError(error)
    }
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
      providerFailure: providerFailureDetails(error),
      stageId: input.stage.id,
    })
  } finally {
    service?.close()
  }
}
