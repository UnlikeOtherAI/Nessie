import type {
  ModelCapabilitySnapshot,
  ModelProviderConfig,
  NormalizedFinishReason,
  ProviderConnector,
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
import {
  collectAnthropicStream,
  nativeToolCallsFromContent,
  normalizeAnthropicFinishReason,
  parseKimiToolCalls,
  toAnthropicPayload,
  type AnthropicMessagesResponse,
  usageFromAnthropic,
} from './kimi-anthropic-protocol.js'
import { createBaseSnapshot } from './model-capabilities.js'
import { isLedgerEndpoint } from '../../ledger-identity.js'

const DEFAULT_KIMI_MODEL = 'kimi-for-coding'
const DEFAULT_KIMI_BASE_URL = 'https://api.kimi.com/coding'

export const createKimiConnector = (
  config: ModelProviderConfig,
): ProviderConnector => {
  if (!config.apiKey) {
    throw new Error('KIMI_API_KEY is not set')
  }

  const baseUrl = config.baseUrl ?? DEFAULT_KIMI_BASE_URL
  const ledgerRouted = isLedgerEndpoint(baseUrl)
  const headers: Record<string, string> = ledgerRouted
    ? {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
      }
    : {
        'Content-Type': 'application/json',
        'x-api-key': config.apiKey,
        'anthropic-version': '2023-06-01',
      }

  const resolveChatModel = (model?: string): string =>
    model ?? config.modelName ?? DEFAULT_KIMI_MODEL

  const fetchModelCapability = async (model: string): Promise<{
    maxInputTokens?: number
    maxOutputTokens?: number
  }> => {
    // Kimi's Messages endpoint requires max_tokens, while its catalogue
    // currently advertises context_length rather than an output limit. That
    // context capacity is the provider's own accepted protocol maximum, not a
    // Nessie response-length policy.
    if (ledgerRouted) return {}
    let response: Response
    try {
      response = await fetch(`${baseUrl}/v1/models`, {
        headers: { ...headers }, method: 'GET',
        signal: AbortSignal.timeout(10_000),
      })
    } catch (error) {
      if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
        throw new Error('Kimi model metadata request timed out')
      }
      throw new Error('Kimi model metadata is temporarily unavailable')
    }
    if (!response.ok) {
      throw await providerHttpError({
        ledgerRouted,
        operation: 'model metadata',
        provider: 'kimi',
        response,
      })
    }
    let body: unknown
    try {
      body = await response.json()
    } catch {
      throw new Error('Kimi model metadata response is malformed')
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new Error('Kimi model metadata response is malformed')
    }
    const data = (body as Record<string, unknown>).data
    if (!Array.isArray(data)) throw new Error('Kimi model metadata response is malformed')
    const row = data.find((entry): entry is Record<string, unknown> =>
      Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry)
      && (entry as Record<string, unknown>).id === model,
    )
    if (!row) throw new Error('Kimi configured model was not found in model metadata')
    const contextLength = typeof row.context_length === 'number' && Number.isInteger(row.context_length) && row.context_length > 0
      ? row.context_length : undefined
    const outputLimit = typeof row.max_output_tokens === 'number' && Number.isInteger(row.max_output_tokens) && row.max_output_tokens > 0
      ? row.max_output_tokens : undefined
    if (contextLength === undefined && outputLimit === undefined) {
      throw new Error('Kimi model metadata response is malformed')
    }
    const protocolOutputLimit = outputLimit ?? contextLength
    return {
      ...(contextLength === undefined ? {} : { maxInputTokens: contextLength }),
      ...(protocolOutputLimit === undefined ? {} : { maxOutputTokens: protocolOutputLimit }),
    }
  }

  const invokeRequest = async (
    body: Record<string, unknown>,
    requestHeaders?: Record<string, string>,
  ): Promise<Response> => {
    const path = ledgerRouted ? '/messages' : '/v1/messages'
    const response = await fetch(`${baseUrl}${path}`, {
      body: JSON.stringify(body),
      headers: { ...requestHeaders, ...headers },
      method: 'POST',
    })

    if (!response.ok) {
      throw await providerHttpError({
        ledgerRouted,
        operation: 'chat',
        provider: 'kimi',
        response,
      })
    }

    return response
  }

  return {
    provider: 'kimi',

    async checkHealth() {
      return {
        checkedAt: nowIso(),
        message: 'Kimi connector does not expose a safe built-in health probe',
        status: 'unknown',
      }
    },

    close(): void {
      // Stateless HTTP connector.
    },

    async fetchCompletion(
      body: Record<string, unknown>,
      requestHeaders?: Record<string, string>,
    ): Promise<Response> {
      return invokeRequest(body, requestHeaders)
    },

    async getModelCapabilities(model: string): Promise<ModelCapabilitySnapshot> {
      const capability = await fetchModelCapability(model)
      return {
        ...createBaseSnapshot({
        model,
        provider: 'kimi',
        structuredOutputMode: 'prompt-json',
        supportsEmbeddings: false,
        // The coding endpoint this connector targets is text-only; a user turn's
        // images are dropped from the Anthropic payload it builds.
        supportsVision: false,
        systemPromptMode: 'native',
        toolCallingMode: 'prompt-translated',
        toolResultMode: 'context-block',
        }),
        ...capability,
        source: capability.maxOutputTokens === undefined ? 'static' : 'live',
      }
    },

    async getProviderMeta() {
      return {
        displayName: 'Kimi (for coding)',
        provider: 'kimi' as const,
        supportsModelDiscovery: false,
      }
    },

    async invoke(
      request: ProviderInvocationRequest,
    ): Promise<ProviderInvocationResult> {
      const startedAt = Date.now()
      const model = resolveChatModel(request.model)
      const payload = toAnthropicPayload(request.messages, request.tools, {
        cache: Boolean(request.promptCacheKey),
      })

      try {
        const response = await invokeRequest({
          ...(request.maxOutputTokens === undefined ? {} : { max_tokens: request.maxOutputTokens }),
          messages: payload.messages,
          model,
          system: payload.system,
          temperature: request.temperature,
        }, request.requestHeaders)

        const parsed = (await response.json()) as AnthropicMessagesResponse
        const rawText = (parsed.content ?? [])
          .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
          .map((block) => block.text)
          .join('')
        const textParsed = parseKimiToolCalls(rawText, request.requestId)
        const outputText = textParsed.outputText
        const toolCalls = [...nativeToolCallsFromContent(parsed.content), ...textParsed.toolCalls]
        const baseFinishReason = normalizeAnthropicFinishReason(parsed.stop_reason)
        const finishReason: NormalizedFinishReason | undefined =
          toolCalls.length > 0 ? 'tool-call' : baseFinishReason
        const usage = usageFromAnthropic(parsed.usage)

        return {
          finishReason,
          invocation: createInvocationRecord({
            correlationId: request.correlationId,
            finishReason,
            latencyMs: Date.now() - startedAt,
            metadata: request.metadata,
            model,
            operationType: 'chat',
            provider: 'kimi',
            requestId: request.requestId,
            usage,
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
          provider: 'kimi',
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
      const payload = toAnthropicPayload(request.messages, request.tools, {
        cache: Boolean(request.promptCacheKey),
      })

      try {
        const response = await invokeRequest({
          ...(request.maxOutputTokens === undefined ? {} : { max_tokens: request.maxOutputTokens }),
          messages: payload.messages,
          model,
          stream: true,
          system: payload.system,
          temperature: request.temperature,
        }, request.requestHeaders)

        const stream = collectAnthropicStream(response)
        let next = await stream.next()
        while (!next.done) {
          yield next.value
          next = await stream.next()
        }

        const textParsed = parseKimiToolCalls(next.value.outputText, request.requestId)
        const outputText = textParsed.outputText
        const toolCalls = [...next.value.toolCalls, ...textParsed.toolCalls]
        const finishReason: NormalizedFinishReason | undefined =
          toolCalls.length > 0 ? 'tool-call' : next.value.finishReason

        return {
          finishReason,
          invocation: createInvocationRecord({
            correlationId: request.correlationId,
            finishReason,
            latencyMs: Date.now() - startedAt,
            metadata: request.metadata,
            model,
            operationType: 'chat',
            provider: 'kimi',
            requestId: request.requestId,
            usage: next.value.usage,
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
          provider: 'kimi',
          requestId: request.requestId,
        })
      }
    },
  }
}
