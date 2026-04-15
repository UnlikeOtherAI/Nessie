import { randomUUID } from 'node:crypto'
import { ProviderInvocationError } from './types.js'
import type {
  ConnectorRegistry,
  InvocationRecord,
  InvocationUsage,
  ModelCapabilitySnapshot,
  ModelProviderConfig,
  ModelProviderName,
  NormalizedFinishReason,
  ProviderConnector,
  ProviderEmbeddingRequest,
  ProviderEmbeddingResult,
  ProviderHealthReport,
  ProviderInvocationRequest,
  ProviderInvocationResult,
  ProviderMessage,
  ProviderToolCall,
  ProviderStreamEvent,
  ToolSchemaDescriptor,
} from './types.js'

type OpenAiUsage = {
  completion_tokens: number
  prompt_tokens: number
  total_tokens?: number
}

type OpenAiChatResponse = {
  choices?: Array<{
    finish_reason?: string | null
    message?: {
      content?: string | null
      tool_calls?: Array<{
        id: string
        type: 'function'
        function: { name: string; arguments: string }
      }>
    }
  }>
  model?: string
  usage?: OpenAiUsage
}

type OpenAiEmbeddingResponse = {
  data?: Array<{ embedding?: number[] }>
  model?: string
  usage?: {
    prompt_tokens: number
    total_tokens?: number
  }
}

type OpenAiStreamChunk = {
  choices?: Array<{
    delta?: {
      content?: string | null
      reasoning_content?: string | null
      tool_calls?: Array<{
        index: number
        id?: string
        type?: 'function'
        function?: { name?: string; arguments?: string }
      }>
    }
    finish_reason?: string | null
    message?: { content?: string | null }
  }>
  usage?: OpenAiUsage
}

type CapturedStreamResult = {
  finishReason?: NormalizedFinishReason
  outputText: string
  toolCalls: ProviderToolCall[]
  usage: InvocationUsage
}

const DEFAULT_OPENAI_MODEL = 'gpt-5-mini'
const DEFAULT_MINIMAX_MODEL = 'MiniMax-M2.5'
const DEFAULT_EMBEDDING_MODEL = 'text-embedding-3-small'
const MINIMAX_CONTEXT_PREFIX = 'Context:\n'

// OpenAI reasoning-era models (gpt-5 family, o1/o3/o4) only accept the
// default temperature. Sending any other value returns HTTP 400
// "Unsupported value: 'temperature' does not support X with this model".
// We drop the field for those models so callers can pass temperature
// freely without having to know the provider matrix.
const OPENAI_REASONING_MODEL_PREFIX_RE = /^(?:gpt-5|o1|o3|o4)(?:[-_]|$)/i
const resolveOpenAiTemperature = (
  model: string,
  temperature: number | undefined,
): number | undefined =>
  OPENAI_REASONING_MODEL_PREFIX_RE.test(model) ? undefined : temperature

const nowIso = (): string => new Date().toISOString()

const safeParseJson = (raw: string): Record<string, unknown> => {
  try {
    return JSON.parse(raw) as Record<string, unknown>
  } catch {
    return { _raw: raw }
  }
}

const normalizeFinishReason = (
  value: string | null | undefined,
): NormalizedFinishReason | undefined => {
  if (!value) {
    return undefined
  }

  switch (value) {
    case 'content_filter':
      return 'content-filter'
    case 'length':
      return 'length'
    case 'stop':
      return 'stop'
    case 'tool_calls':
    case 'tool_call':
      return 'tool-call'
    default:
      return 'other'
  }
}

const usageFromOpenAi = (
  usage: OpenAiUsage | undefined,
): InvocationUsage => {
  if (!usage) {
    return {}
  }

  return {
    inputTokens: usage.prompt_tokens,
    outputTokens: usage.completion_tokens,
    totalTokens:
      usage.total_tokens
      ?? usage.prompt_tokens + usage.completion_tokens,
  }
}

const embeddingUsageFromOpenAi = (
  usage: OpenAiEmbeddingResponse['usage'],
): InvocationUsage => {
  if (!usage) {
    return {}
  }

  return {
    inputTokens: usage.prompt_tokens,
    outputTokens: 0,
    totalTokens: usage.total_tokens ?? usage.prompt_tokens,
  }
}

const createInvocationRecord = (input: {
  correlationId?: string
  finishReason?: NormalizedFinishReason
  latencyMs: number
  metadata?: Record<string, unknown>
  model: string
  operationType: InvocationRecord['operationType']
  provider: InvocationRecord['provider']
  requestId: string
  usage: InvocationUsage
}): InvocationRecord => ({
  correlationId: input.correlationId,
  finishReason: input.finishReason,
  invocationId: randomUUID(),
  latencyMs: input.latencyMs,
  metadata: input.metadata,
  model: input.model,
  operationType: input.operationType,
  provider: input.provider,
  requestId: input.requestId,
  usage: input.usage,
})

const providerError = (input: {
  cause: unknown
  correlationId?: string
  latencyMs: number
  metadata?: Record<string, unknown>
  model: string
  operationType: InvocationRecord['operationType']
  provider: InvocationRecord['provider']
  requestId: string
}): ProviderInvocationError => {
  const message = input.cause instanceof Error
    ? input.cause.message
    : 'Provider request failed'

  return new ProviderInvocationError(
    message,
    createInvocationRecord({
      correlationId: input.correlationId,
      finishReason: 'error',
      latencyMs: input.latencyMs,
      metadata: input.metadata,
      model: input.model,
      operationType: input.operationType,
      provider: input.provider,
      requestId: input.requestId,
      usage: {},
    }),
    input.cause,
  )
}

const collectChatStream = async function* (
  response: Response,
): AsyncGenerator<ProviderStreamEvent, CapturedStreamResult, undefined> {
  if (!response.body) {
    throw new Error('Model response has no body')
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let fallbackMessageContent = ''
  let finishReason: NormalizedFinishReason | undefined
  let outputText = ''
  const toolCalls = new Map<number, { args: string; id: string; name: string }>()
  let usage: InvocationUsage = {}
  let yieldedDelta = false

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const rawLine of lines) {
        const line = rawLine.trim()
        if (!line.startsWith('data: ')) {
          continue
        }

        const data = line.slice(6).trim()
        if (data === '[DONE]') {
          return {
            finishReason,
            outputText,
            toolCalls: Array.from(toolCalls.entries())
              .sort(([left], [right]) => left - right)
              .map(([, value]) => ({
                arguments: safeParseJson(value.args),
                toolCallId: value.id,
                toolName: value.name,
              })),
            usage,
          }
        }

        try {
          const chunk = JSON.parse(data) as OpenAiStreamChunk
          const choice = chunk.choices?.[0]

          if (chunk.usage) {
            usage = usageFromOpenAi(chunk.usage)
          }

          if (choice?.finish_reason) {
            finishReason = normalizeFinishReason(choice.finish_reason)
          }

          const deltaText = choice?.delta?.content ?? ''
          const reasoningText = choice?.delta?.reasoning_content ?? ''
          if (reasoningText) {
            yield { type: 'reasoning_text.delta', text: reasoningText }
          }

          if (deltaText) {
            yieldedDelta = true
            outputText += deltaText
            yield { type: 'output_text.delta', text: deltaText }
            continue
          }

          for (const toolCallDelta of choice?.delta?.tool_calls ?? []) {
            const existing = toolCalls.get(toolCallDelta.index) ?? {
              args: '',
              id: '',
              name: '',
            }

            if (toolCallDelta.id) {
              existing.id = toolCallDelta.id
            }

            if (toolCallDelta.function?.name) {
              existing.name = toolCallDelta.function.name
            }

            if (toolCallDelta.function?.arguments) {
              existing.args += toolCallDelta.function.arguments
              yield {
                type: 'tool_call.delta',
                text: toolCallDelta.function.arguments,
              }
            }

            toolCalls.set(toolCallDelta.index, existing)
          }

          const messageText = choice?.message?.content ?? ''
          if (messageText) {
            fallbackMessageContent = messageText
          }
        } catch {
          // Ignore malformed SSE chunks and continue consuming the stream.
        }
      }
    }
  } finally {
    reader.releaseLock()
  }

  if (!yieldedDelta && fallbackMessageContent) {
    outputText = fallbackMessageContent
    yield { type: 'output_text.delta', text: fallbackMessageContent }
  }

  return {
    finishReason,
    outputText,
    toolCalls: Array.from(toolCalls.entries())
      .sort(([left], [right]) => left - right)
      .map(([, value]) => ({
        arguments: safeParseJson(value.args),
        toolCallId: value.id,
        toolName: value.name,
      })),
    usage,
  }
}

const formatMiniMaxContextBlock = (content: string): string =>
  `${MINIMAX_CONTEXT_PREFIX}${content.trim()}`

const mapToolsToOpenAi = (
  tools: ToolSchemaDescriptor[] | undefined,
):
  | Array<{
    type: 'function'
    function: {
      name: string
      description: string
      parameters: Record<string, unknown>
    }
  }>
  | undefined =>
  tools?.map((tool) => ({
    function: {
      description: tool.description,
      name: tool.toolName,
      parameters: tool.inputSchema,
    },
    type: 'function',
  }))

const mapToolCallsFromOpenAi = (
  toolCalls:
    | Array<{
      id: string
      type: 'function'
      function: { name: string; arguments: string }
    }>
    | undefined,
): ProviderToolCall[] =>
  (toolCalls ?? []).map((toolCall) => ({
    arguments: safeParseJson(toolCall.function.arguments),
    toolCallId: toolCall.id,
    toolName: toolCall.function.name,
  }))

const mapMessagesToOpenAi = (
  messages: ProviderMessage[],
): Array<Record<string, unknown>> =>
  messages.map((message) => {
    if (message.role === 'assistant') {
      return {
        content: message.content ?? '',
        role: 'assistant',
        tool_calls: message.toolCalls?.map((toolCall) => ({
          function: {
            arguments: JSON.stringify(toolCall.arguments),
            name: toolCall.toolName,
          },
          id: toolCall.toolCallId,
          type: 'function',
        })),
      }
    }

    if (message.role === 'tool') {
      return {
        content: message.content,
        role: 'tool',
        tool_call_id: message.toolCallId,
      }
    }

    return message
  })

const normalizeMiniMaxMessages = (
  messages: ProviderMessage[],
): ProviderMessage[] => {
  const normalized: ProviderMessage[] = []
  let pendingSystemContent = ''

  const flushPendingSystem = (): void => {
    if (!pendingSystemContent.trim()) {
      return
    }

    normalized.push({
      content: formatMiniMaxContextBlock(pendingSystemContent),
      role: 'user',
    })
    pendingSystemContent = ''
  }

  for (const message of messages) {
    if (message.role === 'system') {
      pendingSystemContent = pendingSystemContent
        ? `${pendingSystemContent}\n\n${message.content.trim()}`
        : message.content.trim()
      continue
    }

    if (message.role === 'user') {
      const content = pendingSystemContent.trim()
        ? `${formatMiniMaxContextBlock(pendingSystemContent)}\n\n${message.content.trim()}`
        : message.content
      normalized.push({ content, role: 'user' })
      pendingSystemContent = ''
      continue
    }

    if (message.role === 'tool') {
      flushPendingSystem()
      normalized.push({
        content: formatMiniMaxContextBlock(message.content),
        role: 'user',
      })
      continue
    }

    flushPendingSystem()
    normalized.push({
      content: message.content ?? '',
      role: 'assistant',
      toolCalls: message.toolCalls,
    })
  }

  flushPendingSystem()
  return normalized
}

const createBaseSnapshot = (input: {
  discoveredAt?: string
  model: string
  provider: ModelCapabilitySnapshot['provider']
  supportsEmbeddings: boolean
  structuredOutputMode: ModelCapabilitySnapshot['structuredOutputMode']
  systemPromptMode: ModelCapabilitySnapshot['systemPromptMode']
  toolCallingMode: ModelCapabilitySnapshot['toolCallingMode']
  toolResultMode: ModelCapabilitySnapshot['toolResultMode']
}): ModelCapabilitySnapshot => {
  const discoveredAt = input.discoveredAt ?? nowIso()

  return {
    discoveredAt,
    lastVerifiedAt: discoveredAt,
    model: input.model,
    provider: input.provider,
    source: 'static',
    structuredOutputMode: input.structuredOutputMode,
    supportsChat: true,
    supportsEmbeddings: input.supportsEmbeddings,
    supportsModelDiscovery: false,
    supportsStreaming: true,
    supportsVision: false,
    systemPromptMode: input.systemPromptMode,
    toolCallingMode: input.toolCallingMode,
    toolResultMode: input.toolResultMode,
    usageReporting: {
      cacheReadTokens: false,
      cacheWriteTokens: false,
      cachedInputTokens: false,
      cachedOutputTokens: false,
      inputTokens: true,
      outputTokens: true,
      providerReportedCost: false,
    },
  }
}

const createOpenAiLikeConnector = (
  provider: ModelProviderName,
  config: ModelProviderConfig,
): ProviderConnector => {
  if (!config.apiKey) {
    throw new Error('OPENAI_API_KEY / OPENAI_CHAT_API_KEY is not set')
  }

  const baseUrl = config.baseUrl ?? 'https://api.openai.com/v1'
  const headers = {
    Authorization: `Bearer ${config.apiKey}`,
    'Content-Type': 'application/json',
  }

  const resolveChatModel = (model?: string): string =>
    model ?? config.modelName ?? DEFAULT_OPENAI_MODEL

  const invokeRequest = async (
    body: Record<string, unknown>,
  ): Promise<Response> => {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      body: JSON.stringify(body),
      headers,
      method: 'POST',
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`${provider} model error ${response.status}: ${errorText}`)
    }

    return response
  }

  return {
    provider,

    async checkHealth(): Promise<ProviderHealthReport> {
      const startedAt = Date.now()

      try {
        const response = await fetch(`${baseUrl}/models`, {
          headers: {
            Authorization: `Bearer ${config.apiKey}`,
          },
          method: 'GET',
        })

        const latencyMs = Date.now() - startedAt
        if (response.ok) {
          return {
            checkedAt: nowIso(),
            latencyMs,
            status: 'healthy',
          }
        }

        return {
          checkedAt: nowIso(),
          latencyMs,
          message: `${provider} health check failed with status ${response.status}`,
          status: response.status >= 500 ? 'degraded' : 'unreachable',
        }
      } catch (error) {
        return {
          checkedAt: nowIso(),
          latencyMs: Date.now() - startedAt,
          message: error instanceof Error ? error.message : `${provider} health check failed`,
          status: 'unreachable',
        }
      }
    },

    close(): void {
      // Stateless HTTP connector.
    },

    async embed(
      request: ProviderEmbeddingRequest,
    ): Promise<ProviderEmbeddingResult> {
      const startedAt = Date.now()
      const model = request.model ?? DEFAULT_EMBEDDING_MODEL

      try {
        const response = await fetch(`${baseUrl}/embeddings`, {
          body: JSON.stringify({
            input: request.input.slice(0, 8000),
            model,
          }),
          headers,
          method: 'POST',
        })

        if (!response.ok) {
          const errorText = await response.text()
          throw new Error(`${provider} embedding error ${response.status}: ${errorText}`)
        }

        const json = (await response.json()) as OpenAiEmbeddingResponse
        const embedding = json.data?.[0]?.embedding
        if (!embedding) {
          throw new Error('No embedding returned from provider')
        }

        return {
          embedding,
          invocation: createInvocationRecord({
            correlationId: request.correlationId,
            latencyMs: Date.now() - startedAt,
            metadata: request.metadata,
            model: json.model ?? model,
            operationType: 'embedding',
            provider,
            requestId: request.requestId,
            usage: embeddingUsageFromOpenAi(json.usage),
          }),
        }
      } catch (error) {
        throw providerError({
          cause: error,
          correlationId: request.correlationId,
          latencyMs: Date.now() - startedAt,
          metadata: request.metadata,
          model,
          operationType: 'embedding',
          provider,
          requestId: request.requestId,
        })
      }
    },

    async fetchCompletion(body: Record<string, unknown>): Promise<Response> {
      return invokeRequest(body)
    },

    async getModelCapabilities(model: string): Promise<ModelCapabilitySnapshot> {
      return createBaseSnapshot({
        model,
        provider,
        structuredOutputMode: 'native-json',
        supportsEmbeddings: true,
        systemPromptMode: 'native',
        toolCallingMode: 'native',
        toolResultMode: 'native-tool-message',
      })
    },

    async getProviderMeta() {
      return {
        displayName: provider === 'openai' ? 'OpenAI' : 'OpenAI-compatible',
        provider,
        supportsModelDiscovery: false,
      }
    },

    async invoke(
      request: ProviderInvocationRequest,
    ): Promise<ProviderInvocationResult> {
      const startedAt = Date.now()
      const model = resolveChatModel(request.model)

      try {
        const tools = mapToolsToOpenAi(request.tools)
        const response = await invokeRequest({
          max_completion_tokens: request.maxOutputTokens ?? 1024,
          messages: mapMessagesToOpenAi(request.messages),
          model,
          response_format: request.responseFormat,
          temperature: resolveOpenAiTemperature(model, request.temperature),
          tool_choice: request.toolChoice,
          tools,
        })

        const json = (await response.json()) as OpenAiChatResponse
        const outputText = json.choices?.[0]?.message?.content ?? ''
        const toolCalls = mapToolCallsFromOpenAi(
          json.choices?.[0]?.message?.tool_calls,
        )
        const finishReason = normalizeFinishReason(
          json.choices?.[0]?.finish_reason,
        )

        return {
          finishReason,
          invocation: createInvocationRecord({
            correlationId: request.correlationId,
            finishReason,
            latencyMs: Date.now() - startedAt,
            metadata: request.metadata,
            model: json.model ?? model,
            operationType: 'chat',
            provider,
            requestId: request.requestId,
            usage: usageFromOpenAi(json.usage),
          }),
          outputText,
          toolCalls,
        }
      } catch (error) {
        throw providerError({
          cause: error,
          correlationId: request.correlationId,
          latencyMs: Date.now() - startedAt,
          metadata: request.metadata,
          model,
          operationType: 'chat',
          provider,
          requestId: request.requestId,
        })
      }
    },

    async listModels(): Promise<ModelCapabilitySnapshot[]> {
      return []
    },

    async *stream(
      request: ProviderInvocationRequest,
    ): AsyncGenerator<ProviderStreamEvent, ProviderInvocationResult, undefined> {
      const startedAt = Date.now()
      const model = resolveChatModel(request.model)

      try {
        const tools = mapToolsToOpenAi(request.tools)
        const response = await invokeRequest({
          max_completion_tokens: request.maxOutputTokens ?? 1024,
          messages: mapMessagesToOpenAi(request.messages),
          model,
          response_format: request.responseFormat,
          stream: true,
          stream_options: { include_usage: true },
          temperature: resolveOpenAiTemperature(model, request.temperature),
          tool_choice: request.toolChoice,
          tools,
        })

        const stream = collectChatStream(response)
        let next = await stream.next()
        while (!next.done) {
          yield next.value
          next = await stream.next()
        }

        return {
          finishReason: next.value.finishReason,
          invocation: createInvocationRecord({
            correlationId: request.correlationId,
            finishReason: next.value.finishReason,
            latencyMs: Date.now() - startedAt,
            metadata: request.metadata,
            model,
            operationType: 'chat',
            provider,
            requestId: request.requestId,
            usage: next.value.usage,
          }),
          outputText: next.value.outputText,
          toolCalls: next.value.toolCalls,
        }
      } catch (error) {
        throw providerError({
          cause: error,
          correlationId: request.correlationId,
          latencyMs: Date.now() - startedAt,
          metadata: request.metadata,
          model,
          operationType: 'chat',
          provider,
          requestId: request.requestId,
        })
      }
    },
  }
}

const createMiniMaxConnector = (
  config: ModelProviderConfig,
): ProviderConnector => {
  if (!config.apiKey) {
    throw new Error('MINIMAX_API_KEY is not set')
  }

  const baseUrl = config.baseUrl ?? 'https://api.minimax.io/v1'
  const headers = {
    Authorization: `Bearer ${config.apiKey}`,
    'Content-Type': 'application/json',
  }

  const resolveChatModel = (model?: string): string =>
    model ?? config.modelName ?? DEFAULT_MINIMAX_MODEL

  const invokeRequest = async (
    body: Record<string, unknown>,
  ): Promise<Response> => {
    const response = await fetch(`${baseUrl}/text/chatcompletion_v2`, {
      body: JSON.stringify(body),
      headers,
      method: 'POST',
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`MiniMax model error ${response.status}: ${errorText}`)
    }

    return response
  }

  return {
    provider: 'minimax',

    async checkHealth(): Promise<ProviderHealthReport> {
      return {
        checkedAt: nowIso(),
        message: 'MiniMax connector does not expose a safe built-in health probe',
        status: 'unknown',
      }
    },

    close(): void {
      // Stateless HTTP connector.
    },

    async fetchCompletion(body: Record<string, unknown>): Promise<Response> {
      return invokeRequest(body)
    },

    async getModelCapabilities(model: string): Promise<ModelCapabilitySnapshot> {
      return createBaseSnapshot({
        model,
        provider: 'minimax',
        structuredOutputMode: 'prompt-json',
        supportsEmbeddings: false,
        systemPromptMode: 'fold-into-user',
        toolCallingMode: 'prompt-translated',
        toolResultMode: 'context-block',
      })
    },

    async getProviderMeta() {
      return {
        displayName: 'MiniMax',
        provider: 'minimax' as const,
        supportsModelDiscovery: false,
      }
    },

    async invoke(
      request: ProviderInvocationRequest,
    ): Promise<ProviderInvocationResult> {
      const startedAt = Date.now()
      const model = resolveChatModel(request.model)

      try {
        const response = await invokeRequest({
          max_completion_tokens: request.maxOutputTokens ?? 1024,
          messages: normalizeMiniMaxMessages(request.messages),
          model,
          stream: true,
          temperature: request.temperature,
        })

        const stream = collectChatStream(response)
        let next = await stream.next()
        while (!next.done) {
          next = await stream.next()
        }

        return {
          finishReason: next.value.finishReason,
          invocation: createInvocationRecord({
            correlationId: request.correlationId,
            finishReason: next.value.finishReason,
            latencyMs: Date.now() - startedAt,
            metadata: request.metadata,
            model,
            operationType: 'chat',
            provider: 'minimax',
            requestId: request.requestId,
            usage: next.value.usage,
          }),
          outputText: next.value.outputText,
          toolCalls: next.value.toolCalls,
        }
      } catch (error) {
        throw providerError({
          cause: error,
          correlationId: request.correlationId,
          latencyMs: Date.now() - startedAt,
          metadata: request.metadata,
          model,
          operationType: 'chat',
          provider: 'minimax',
          requestId: request.requestId,
        })
      }
    },

    async listModels(): Promise<ModelCapabilitySnapshot[]> {
      return []
    },

    async *stream(
      request: ProviderInvocationRequest,
    ): AsyncGenerator<ProviderStreamEvent, ProviderInvocationResult, undefined> {
      const startedAt = Date.now()
      const model = resolveChatModel(request.model)

      try {
        const response = await invokeRequest({
          max_completion_tokens: request.maxOutputTokens ?? 1024,
          messages: normalizeMiniMaxMessages(request.messages),
          model,
          stream: true,
          temperature: request.temperature,
        })

        const stream = collectChatStream(response)
        let next = await stream.next()
        while (!next.done) {
          yield next.value
          next = await stream.next()
        }

        return {
          finishReason: next.value.finishReason,
          invocation: createInvocationRecord({
            correlationId: request.correlationId,
            finishReason: next.value.finishReason,
            latencyMs: Date.now() - startedAt,
            metadata: request.metadata,
            model,
            operationType: 'chat',
            provider: 'minimax',
            requestId: request.requestId,
            usage: next.value.usage,
          }),
          outputText: next.value.outputText,
          toolCalls: next.value.toolCalls,
        }
      } catch (error) {
        throw providerError({
          cause: error,
          correlationId: request.correlationId,
          latencyMs: Date.now() - startedAt,
          metadata: request.metadata,
          model,
          operationType: 'chat',
          provider: 'minimax',
          requestId: request.requestId,
        })
      }
    },
  }
}

export const createConnectorRegistry = (): ConnectorRegistry => {
  const factories = new Map<
    ModelProviderName,
    (config: ModelProviderConfig) => ProviderConnector
  >([
    ['minimax', createMiniMaxConnector],
    ['openai', (config) => createOpenAiLikeConnector('openai', config)],
    [
      'openai-compatible',
      (config) => createOpenAiLikeConnector('openai-compatible', config),
    ],
  ])

  return {
    getConfigured(config: ModelProviderConfig): ProviderConnector {
      const factory = factories.get(config.provider)
      if (!factory) {
        throw new Error(`No provider connector is registered for ${config.provider}`)
      }

      return factory(config)
    },

    listRegistered() {
      return Array.from(factories.keys())
    },

    register(
      provider: ModelProviderName,
      factory,
    ): void {
      factories.set(provider, factory)
    },
  }
}
