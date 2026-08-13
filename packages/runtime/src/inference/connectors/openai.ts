import { EMBEDDING_DIMENSIONS } from '@nessie/schemas'
import type {
  ModelCapabilitySnapshot,
  ModelProviderConfig,
  ModelProviderName,
  ProviderConnector,
  ProviderEmbeddingBatchRequest,
  ProviderEmbeddingBatchResult,
  ProviderEmbeddingRequest,
  ProviderEmbeddingResult,
  ProviderHealthReport,
  ProviderInvocationRequest,
  ProviderInvocationResult,
  ProviderStreamEvent,
} from '../types.js'
import {
  createInvocationRecord,
  nowIso,
  providerError,
} from './connector-invocations.js'
import { createBaseSnapshot } from './model-capabilities.js'
import {
  collectChatStream,
  DEFAULT_EMBEDDING_MODEL,
  DEFAULT_OPENAI_MODEL,
  embeddingUsageFromOpenAi,
  mapMessagesToOpenAi,
  mapToolCallsFromOpenAi,
  mapToolsToOpenAi,
  normalizeFinishReason,
  resolveOpenAiTemperature,
  type OpenAiChatResponse,
  type OpenAiEmbeddingResponse,
  usageFromOpenAi,
} from './openai-chat-protocol.js'

export const createOpenAiLikeConnector = (
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

  // OpenAI's chat endpoint — and the OpenAI-compatible endpoints Nessie routes
  // through Ledger — take inline image parts. DeepSeek's chat API is text-only
  // and rejects them, so its turns stay plain strings.
  const supportsVision = provider !== 'deepseek'

  const invokeRequest = async (
    body: Record<string, unknown>,
    requestHeaders?: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<Response> => {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      body: JSON.stringify(body),
      headers: { ...requestHeaders, ...headers },
      method: 'POST',
      signal,
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

    // `dimensions` is sent on every embed call, not left to the model's
    // default: the destination column is `vector(EMBEDDING_DIMENSIONS)`, so a
    // provider that would answer at some other width has to say so by
    // rejecting the request rather than by returning vectors the database
    // silently refuses later. OpenAI's text-embedding-3-* and Jina v3 both
    // honour it.
    async embed(
      request: ProviderEmbeddingRequest,
    ): Promise<ProviderEmbeddingResult> {
      const startedAt = Date.now()
      const model = request.model ?? DEFAULT_EMBEDDING_MODEL

      try {
        const response = await fetch(`${baseUrl}/embeddings`, {
          body: JSON.stringify({
            dimensions: EMBEDDING_DIMENSIONS,
            input: request.input.slice(0, 8000),
            model,
          }),
          headers: { ...request.requestHeaders, ...headers },
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

    async embedBatch(
      request: ProviderEmbeddingBatchRequest,
    ): Promise<ProviderEmbeddingBatchResult> {
      const startedAt = Date.now()
      const model = request.model ?? DEFAULT_EMBEDDING_MODEL

      try {
        const response = await fetch(`${baseUrl}/embeddings`, {
          body: JSON.stringify({
            dimensions: EMBEDDING_DIMENSIONS,
            input: request.input.map((text) => text.slice(0, 8000)),
            model,
          }),
          headers: { ...request.requestHeaders, ...headers },
          method: 'POST',
        })

        if (!response.ok) {
          const errorText = await response.text()
          throw new Error(`${provider} embedding error ${response.status}: ${errorText}`)
        }

        const json = (await response.json()) as OpenAiEmbeddingResponse
        const data = json.data ?? []
        if (data.length !== request.input.length) {
          throw new Error(
            `Expected ${request.input.length} embeddings from provider, got ${data.length}`,
          )
        }

        const embeddings = [...data]
          .sort((left, right) => (left.index ?? 0) - (right.index ?? 0))
          .map((item) => {
            if (!item.embedding) {
              throw new Error('No embedding returned from provider')
            }
            return item.embedding
          })

        return {
          embeddings,
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

    async fetchCompletion(
      body: Record<string, unknown>,
      requestHeaders?: Record<string, string>,
    ): Promise<Response> {
      return invokeRequest(body, requestHeaders)
    },

    async getModelCapabilities(model: string): Promise<ModelCapabilitySnapshot> {
      return createBaseSnapshot({
        model,
        provider,
        structuredOutputMode: 'native-json',
        supportsEmbeddings: true,
        supportsVision,
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
          messages: mapMessagesToOpenAi(request.messages, { vision: supportsVision }),
          model,
          // Routes requests with the same prefix to the same prompt cache for a
          // higher hit rate (undefined is dropped by JSON.stringify).
          prompt_cache_key: request.promptCacheKey,
          // Dropped from the JSON body when undefined; providers reject unknown
          // reasoning-effort values, so callers pass an already-clamped value.
          reasoning_effort: request.reasoningEffort,
          response_format: request.responseFormat,
          temperature: resolveOpenAiTemperature(model, request.temperature),
          tool_choice: request.toolChoice,
          tools,
        }, request.requestHeaders, request.signal)

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
          messages: mapMessagesToOpenAi(request.messages, { vision: supportsVision }),
          model,
          prompt_cache_key: request.promptCacheKey,
          reasoning_effort: request.reasoningEffort,
          response_format: request.responseFormat,
          stream: true,
          stream_options: { include_usage: true },
          temperature: resolveOpenAiTemperature(model, request.temperature),
          tool_choice: request.toolChoice,
          tools,
        }, request.requestHeaders, request.signal)

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
