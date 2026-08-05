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
} from './connector-invocations.js'
import {
  collectAnthropicStream,
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
      const errorText = await response.text()
      throw new Error(`Kimi model error ${response.status}: ${errorText}`)
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
      return createBaseSnapshot({
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
      })
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
          max_tokens: request.maxOutputTokens ?? 1024,
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
        const { outputText, toolCalls } = parseKimiToolCalls(rawText, request.requestId)
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
          max_tokens: request.maxOutputTokens ?? 1024,
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

        const { outputText, toolCalls } = parseKimiToolCalls(
          next.value.outputText,
          request.requestId,
        )
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
