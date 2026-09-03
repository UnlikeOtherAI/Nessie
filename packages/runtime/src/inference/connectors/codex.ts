import type {
  ModelCapabilitySnapshot,
  ModelProviderConfig,
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
  collectCodexStream,
  DEFAULT_CODEX_MODEL,
  mapMessagesToCodex,
  mapToolsToCodex,
  readCodexResponse,
  type CodexRequestBody,
} from './codex-responses-protocol.js'

const PROVIDER = 'codex-subscription' as const

/**
 * ChatGPT's Codex backend, reached with a person's own subscription grant.
 *
 * It is never Ledger-routed by construction: this connector only ever exists on
 * a run pinned to a personal subscription, whose base URL comes from the
 * adapter constant. `providerHttpError` is therefore called with
 * `ledgerRouted: false` — a 402 here is the person's own plan refusing, and
 * dressing it as a Ledger credit refusal would tell them to buy organisation
 * credits that would not help.
 */
export const createCodexConnector = (
  config: ModelProviderConfig,
): ProviderConnector => {
  if (!config.apiKey) {
    throw new Error('A personal Codex subscription credential is required')
  }

  const baseUrl = config.baseUrl ?? 'https://chatgpt.com/backend-api/codex'
  const headers = {
    ...(config.extraHeaders ?? {}),
    Authorization: `Bearer ${config.apiKey}`,
    'Content-Type': 'application/json',
  }

  const resolveModel = (model?: string): string =>
    model ?? config.modelName ?? DEFAULT_CODEX_MODEL

  const buildBody = (
    request: ProviderInvocationRequest,
    model: string,
    stream: boolean,
  ): CodexRequestBody => {
    const { input, instructions } = mapMessagesToCodex(request.messages, {
      vision: true,
    })
    const tools = mapToolsToCodex(request.tools)
    return {
      input,
      ...(instructions ? { instructions } : {}),
      ...(request.maxOutputTokens ? { max_output_tokens: request.maxOutputTokens } : {}),
      model,
      ...(request.reasoningEffort ? { reasoning: { effort: request.reasoningEffort } } : {}),
      // The backend must not retain this conversation: the transcript is
      // Nessie's, and a stored copy would put a team's content in a
      // person's ChatGPT history where its disclosure rules do not reach.
      store: false,
      stream,
      ...(tools ? { tools } : {}),
      ...(request.toolChoice ? { tool_choice: request.toolChoice } : {}),
    }
  }

  const post = async (
    body: CodexRequestBody,
    requestHeaders?: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<Response> => {
    const response = await fetch(`${baseUrl}/responses`, {
      body: JSON.stringify(body),
      headers: { ...requestHeaders, ...headers },
      method: 'POST',
      ...(signal ? { signal } : {}),
    })
    if (!response.ok) {
      throw await providerHttpError({
        ledgerRouted: false,
        operation: 'chat',
        provider: PROVIDER,
        response,
      })
    }
    return response
  }

  const unsupportedEmbedding = (): never => {
    throw new Error('The Codex subscription backend does not serve embeddings')
  }

  return {
    provider: PROVIDER,

    async checkHealth(): Promise<ProviderHealthReport> {
      // The backend exposes no unauthenticated probe, and spending a real
      // generation to answer "is it up" would bill the person for a health
      // check. Liveness is proven by the next actual run.
      return { checkedAt: nowIso(), status: 'unknown' }
    },

    close(): void {
      // Stateless HTTP connector.
    },

    async embed(_request: ProviderEmbeddingRequest): Promise<ProviderEmbeddingResult> {
      return unsupportedEmbedding()
    },

    async embedBatch(
      _request: ProviderEmbeddingBatchRequest,
    ): Promise<ProviderEmbeddingBatchResult> {
      return unsupportedEmbedding()
    },

    async getModelCapabilities(model: string): Promise<ModelCapabilitySnapshot> {
      return createBaseSnapshot({
        model,
        provider: PROVIDER,
        structuredOutputMode: 'native-json',
        supportsEmbeddings: false,
        supportsVision: true,
        systemPromptMode: 'native',
        toolCallingMode: 'native',
        toolResultMode: 'native-tool-message',
      })
    },

    async getProviderMeta() {
      return {
        displayName: 'ChatGPT Codex (personal subscription)',
        provider: PROVIDER,
        supportsModelDiscovery: false,
      }
    },

    async listModels() {
      return []
    },

    async invoke(request: ProviderInvocationRequest): Promise<ProviderInvocationResult> {
      const startedAt = Date.now()
      const model = resolveModel(request.model)
      try {
        const response = await post(
          buildBody(request, model, false),
          request.requestHeaders,
          request.signal,
        )
        const result = readCodexResponse(
          (await response.json()) as Record<string, unknown>,
        )
        return {
          finishReason: result.finishReason,
          invocation: createInvocationRecord({
            correlationId: request.correlationId,
            finishReason: result.finishReason,
            latencyMs: Date.now() - startedAt,
            metadata: request.metadata,
            model,
            operationType: 'chat',
            provider: PROVIDER,
            requestId: request.requestId,
            usage: result.usage,
          }),
          outputText: result.outputText,
          toolCalls: result.toolCalls,
        }
      } catch (error) {
        throw providerError({
          cause: error,
          correlationId: request.correlationId,
          latencyMs: Date.now() - startedAt,
          metadata: request.metadata,
          model,
          operationType: 'chat',
          provider: PROVIDER,
          requestId: request.requestId,
        })
      }
    },

    /**
     * Raw passthrough for callers that build their own body (the Agent
     * Designer). Same endpoint, same credential — never a second code path for
     * constructing the request.
     */
    async fetchCompletion(
      body: Record<string, unknown>,
      requestHeaders?: Record<string, string>,
    ): Promise<Response> {
      return post(body as unknown as CodexRequestBody, requestHeaders)
    },

    async *stream(
      request: ProviderInvocationRequest,
    ): AsyncGenerator<ProviderStreamEvent, ProviderInvocationResult, undefined> {
      const startedAt = Date.now()
      const model = resolveModel(request.model)
      try {
        const response = await post(
          buildBody(request, model, true),
          request.requestHeaders,
          request.signal,
        )
        const stream = collectCodexStream(response)
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
            provider: PROVIDER,
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
          provider: PROVIDER,
          requestId: request.requestId,
        })
      }
    },
  }
}
