import { EMBEDDING_DIMENSIONS } from '@nessie/schemas'
import { isLedgerEndpoint } from '../../ledger-identity.js'
import { safeFetch, type SafeFetchOptions } from '../../url-safety.js'
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
  providerHttpError,
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
  type OpenAiChatResponse,
  type OpenAiEmbeddingResponse,
  reasoningTextFromOpenAi,
  resolveOpenAiTemperature,
  usageFromOpenAi,
} from './openai-chat-protocol.js'
import { applyReasoningDialect, resolveReasoningDialect } from './reasoning-dialect.js'

/** Internal test seam for the pinned direct-DeepSeek transport. */
export type OpenAiLikeConnectorOptions = {
  pinnedFetchOptions?: SafeFetchOptions
}

export const createOpenAiLikeConnector = (
  provider: ModelProviderName,
  config: ModelProviderConfig,
  options: OpenAiLikeConnectorOptions = {},
): ProviderConnector => {
  if (!config.apiKey) {
    throw new Error('OPENAI_API_KEY / OPENAI_CHAT_API_KEY is not set')
  }

  const baseUrl = config.baseUrl ?? 'https://api.openai.com/v1'
  const ledgerRouted = isLedgerEndpoint(baseUrl)
  const headers = {
    ...(config.extraHeaders ?? {}),
    Authorization: `Bearer ${config.apiKey}`,
    'Content-Type': 'application/json',
  }

  const resolveChatModel = (model?: string): string =>
    model ?? config.modelName ?? DEFAULT_OPENAI_MODEL

  // OpenAI's chat endpoint — and the OpenAI-compatible endpoints Nessie routes
  // through Ledger — take inline image parts. DeepSeek's chat API is text-only
  // and rejects them, so its turns stay plain strings.
  const supportsVision = provider !== 'deepseek'
  // A DeepSeek key that is not Ledger's is a person's own (the personal
  // subscription lane) or a direct deployment; either way the egress is a
  // caller-influenced vendor host and goes through the pinned dispatcher.
  const pinnedTransport = provider === 'deepseek' && !ledgerRouted
  // Resolved once from code-owned facts. The dialect decides the thinking
  // switch, the output-cap field and whether an assistant turn's reasoning is
  // sent back, for `invoke`, `stream` and the raw `fetchCompletion` alike.
  const dialect = resolveReasoningDialect({ provider, serviceId: config.serviceId })

  const invokeRequest = async (
    body: Record<string, unknown>,
    requestHeaders?: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<Response> => {
    const init: RequestInit = {
      body: JSON.stringify(applyReasoningDialect(dialect, body)),
      headers: { ...requestHeaders, ...headers },
      method: 'POST',
      signal,
    }
    const response = pinnedTransport
      ? await safeFetch(
        new URL('chat/completions', `${baseUrl.replace(/\/+$/, '')}/`),
        init,
        {
          ...options.pinnedFetchOptions,
          credentialsPresent: true,
          maxRedirects: 0,
        },
      )
      : await fetch(`${baseUrl}/chat/completions`, init)

    if (!response.ok) {
      throw await providerHttpError({
        ledgerRouted,
        operation: 'chat',
        provider,
        response,
      })
    }

    return response
  }

  const chatBody = (
    request: ProviderInvocationRequest,
    model: string,
    stream: boolean,
  ): Record<string, unknown> => ({
    // OpenAI's field; the DeepSeek dialect renames it to the `max_tokens` that
    // API documents.
    ...(request.maxOutputTokens === undefined
      ? {}
      : { max_completion_tokens: request.maxOutputTokens }),
    messages: mapMessagesToOpenAi(request.messages, { vision: supportsVision }),
    model,
    // Routes requests with the same prefix to the same prompt cache for a
    // higher hit rate (undefined is dropped by JSON.stringify).
    prompt_cache_key: request.promptCacheKey,
    // Dropped from the JSON body when undefined; providers reject unknown
    // reasoning-effort values, so callers pass an already-clamped value.
    reasoning_effort: request.reasoningEffort,
    response_format: request.responseFormat,
    ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}),
    temperature: resolveOpenAiTemperature(model, request.temperature),
    tool_choice: request.toolChoice,
    tools: mapToolsToOpenAi(request.tools),
  })

  return {
    provider,

    async checkHealth(): Promise<ProviderHealthReport> {
      const startedAt = Date.now()

      try {
        const init: RequestInit = {
          headers: {
            Authorization: `Bearer ${config.apiKey}`,
          },
          method: 'GET',
        }
        const response = pinnedTransport
          ? await safeFetch(
            new URL('/models', `${baseUrl.replace(/\/+$/, '')}/`),
            init,
            {
              ...options.pinnedFetchOptions,
              credentialsPresent: true,
              maxRedirects: 0,
            },
          )
          : await fetch(`${baseUrl}/models`, init)

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
          throw await providerHttpError({
            ledgerRouted,
            operation: 'embedding',
            provider,
            response,
          })
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
          throw await providerHttpError({
            ledgerRouted,
            operation: 'embedding',
            provider,
            response,
          })
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

    // Raw body escape hatch (the Designer). The dialect is applied inside
    // `invokeRequest`, so a caller here can neither re-enable thinking on a
    // silent call nor send a provider a field it rejects.
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
        const response = await invokeRequest(
          chatBody(request, model, false),
          request.requestHeaders,
          request.signal,
        )

        const json = (await response.json()) as OpenAiChatResponse
        const message = json.choices?.[0]?.message
        const outputText = message?.content ?? ''
        const reasoningText = reasoningTextFromOpenAi(message)
        const toolCalls = mapToolCallsFromOpenAi(message?.tool_calls)
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
          ...(reasoningText ? { reasoningText } : {}),
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
        const response = await invokeRequest(
          chatBody(request, model, true),
          request.requestHeaders,
          request.signal,
        )

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
          ...(next.value.reasoningText ? { reasoningText: next.value.reasoningText } : {}),
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
