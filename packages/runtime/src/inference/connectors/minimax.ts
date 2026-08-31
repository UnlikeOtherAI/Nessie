import type {
  ModelCapabilitySnapshot,
  ModelProviderConfig,
  ProviderConnector,
  ProviderInvocationRequest,
  ProviderInvocationResult,
  ProviderMessage,
  ProviderStreamEvent,
} from '../types.js'
import {
  createInvocationRecord,
  nowIso,
  providerError,
  providerHttpError,
} from './connector-invocations.js'
import { isLedgerEndpoint } from '../../ledger-identity.js'
import { createBaseSnapshot } from './model-capabilities.js'
import { collectChatStream } from './openai-chat-protocol.js'

const DEFAULT_MINIMAX_MODEL = 'MiniMax-M2.5'
const MINIMAX_CONTEXT_PREFIX = 'Context:\n'

const formatMiniMaxContextBlock = (content: string): string =>
  `${MINIMAX_CONTEXT_PREFIX}${content.trim()}`

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

export const createMiniMaxConnector = (
  config: ModelProviderConfig,
): ProviderConnector => {
  if (!config.apiKey) {
    throw new Error('MINIMAX_API_KEY is not set')
  }

  const baseUrl = config.baseUrl ?? 'https://api.minimax.io/v1'
  const ledgerRouted = isLedgerEndpoint(baseUrl)
  const headers = {
    Authorization: `Bearer ${config.apiKey}`,
    'Content-Type': 'application/json',
  }

  const resolveChatModel = (model?: string): string =>
    model ?? config.modelName ?? DEFAULT_MINIMAX_MODEL

  const invokeRequest = async (
    body: Record<string, unknown>,
    requestHeaders?: Record<string, string>,
  ): Promise<Response> => {
    const path = ledgerRouted
      ? '/chat/completions'
      : '/text/chatcompletion_v2'
    const response = await fetch(`${baseUrl}${path}`, {
      body: JSON.stringify(body),
      headers: { ...requestHeaders, ...headers },
      method: 'POST',
    })

    if (!response.ok) {
      throw await providerHttpError({
        ledgerRouted,
        operation: 'chat',
        provider: 'minimax',
        response,
      })
    }

    return response
  }

  return {
    provider: 'minimax',

    async checkHealth() {
      return {
        checkedAt: nowIso(),
        message: 'MiniMax connector does not expose a safe built-in health probe',
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
        provider: 'minimax',
        structuredOutputMode: 'prompt-json',
        supportsEmbeddings: false,
        // The text models this connector targets take no image parts; the
        // normalizer below rebuilds user turns without them.
        supportsVision: false,
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
        }, request.requestHeaders)

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
        }, request.requestHeaders)

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
