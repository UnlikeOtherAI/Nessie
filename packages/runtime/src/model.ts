import type { ProviderReasoningEffort } from '@nessie/schemas'
import {
  isSameInferenceHost,
  resolveEmbeddingProvider,
  type EmbeddingProviderOverride,
} from './inference/embedding-provider.js'
import { createInferenceService } from './inference/service.js'
import type {
  InferenceService,
  ModelProviderConfig,
  ProviderMessage,
} from './inference/types.js'
import type { LedgerAttribution, LedgerInvocation } from './ledger.js'
import { completeLedgerAttribution } from './ledger-attribution.js'
import { ModelUsageTracker } from './usage.js'

export type { ModelProviderConfig, ModelProviderName } from './inference/types.js'
export type {
  EmbeddingProviderOverride,
  ResolvedEmbeddingProvider,
} from './inference/embedding-provider.js'
export {
  isSameInferenceHost,
  resolveEmbeddingProvider,
} from './inference/embedding-provider.js'

export type ModelMessage = {
  role: 'system' | 'user' | 'assistant'
  content: string
}

// When `usage` is set on a call, the client records the invocation(s) to the
// persistent token ledger (via the recordUsage sink wired at construction) with
// this attribution — in addition to the in-memory tracker. Omit it for calls
// that should not be billed (e.g. health checks).
export type ModelOptions = {
  maxTokens?: number
  model?: string
  temperature?: number
  responseFormat?: { type: 'json_object' }
  // Stable key so repeated calls sharing a prefix hit the same prompt cache.
  promptCacheKey?: string
  // Sent to OpenAI-compatible providers as `reasoning_effort` when set.
  reasoningEffort?: ProviderReasoningEffort
  usage?: LedgerAttribution
}

// No `model` here on purpose. Which model produces embeddings is a deployment
// decision, not a per-call one: every vector in a pgvector column has to come
// from the same model or cosine distance across them is meaningless. Callers
// that need to record or cache by model read `ModelClient.embeddingModel`.
export type EmbedOptions = {
  usage?: LedgerAttribution
}

export type FetchCompletionOptions = {
  usage?: LedgerAttribution
}

// Persists billable invocations to the token ledger. Wired by api/worker at
// construction so the shared model client attributes usage exactly like the
// worker agentic loop does.
export type ModelUsageSink = (
  invocations: LedgerInvocation[],
  attribution: LedgerAttribution,
) => Promise<void>

export type CreateModelClientOptions = {
  tracker?: ModelUsageTracker
  recordUsage?: ModelUsageSink
  systemComponent?: string
  requestHeaders?: (
    attribution: LedgerAttribution,
  ) => Promise<Record<string, string>>
  // Sends embeddings somewhere other than the chat provider. Omit it and
  // embeddings go exactly where they went before.
  embedding?: EmbeddingProviderOverride
}

export interface ModelClient {
  chat(messages: ModelMessage[], options?: ModelOptions): Promise<string>
  chatJson<T = unknown>(messages: ModelMessage[], options?: ModelOptions): Promise<T>
  embed(text: string, options?: EmbedOptions): Promise<number[]>
  embedMany(texts: string[], options?: EmbedOptions): Promise<number[][]>
  // The model `embed`/`embedMany` ask for. Persisted alongside stored vectors
  // and used as the query-embedding cache key, so both sides of a similarity
  // comparison can prove they came from the same model.
  readonly embeddingModel: string
  stream(
    messages: ModelMessage[],
    options?: ModelOptions,
  ): AsyncGenerator<string, void, undefined>
  fetchCompletion(
    body: Record<string, unknown>,
    options?: FetchCompletionOptions,
  ): Promise<Response>
  close(): void
  readonly usage: ModelUsageTracker
}

const toProviderMessages = (messages: ModelMessage[]): ProviderMessage[] =>
  messages.map((message) => ({
    content: message.content,
    role: message.role,
  }))

const recordUsageFromModel = (
  tracker: ModelUsageTracker,
  model: string,
  usage: {
    inputTokens?: number
    outputTokens?: number
  },
): void => {
  if (
    usage.inputTokens === undefined
    && usage.outputTokens === undefined
  ) {
    return
  }

  tracker.record(
    model,
    usage.inputTokens ?? 0,
    usage.outputTokens ?? 0,
  )
}

export const createModelClient = (
  config: ModelProviderConfig,
  options: CreateModelClientOptions = {},
): ModelClient => {
  const usageTracker = options.tracker ?? new ModelUsageTracker()
  const recordUsage = options.recordUsage
  const requestHeaders = options.requestHeaders
  const systemComponent = options.systemComponent
  const inferenceService = createInferenceService(config)

  // Embeddings get their own connector only when the deployment named a
  // separate destination; otherwise they share the chat service object, so an
  // unconfigured deployment behaves as if none of this existed.
  const embedding = resolveEmbeddingProvider(config, options.embedding)
  const embeddingService: InferenceService = embedding.config
    ? createInferenceService(embedding.config)
    : inferenceService

  // The caller wires a signer for the destination it built this client around.
  // An embedding override that names its own host is a different destination,
  // and a UOA delegation assertion must not follow it there — an operator
  // pointing embeddings at their own inference box would otherwise have one
  // posted to it. Same host (Ledger's `/v1/jina` beside `/v1/deepseek`) is the
  // same destination, so it signs exactly as chat does.
  const embeddingSigner = isSameInferenceHost(
    embedding.config?.baseUrl ?? config.baseUrl,
    config.baseUrl,
  )
    ? requestHeaders
    : undefined

  const resolveAttribution = (
    attribution: LedgerAttribution | undefined,
  ): LedgerAttribution | undefined => {
    if (!requestHeaders) {
      return attribution
    }
    if (!attribution) {
      throw new Error(
        'Ledger-routed model calls require explicit usage attribution.',
      )
    }
    return completeLedgerAttribution(attribution, systemComponent)
  }

  const resolveHeaders = (
    attribution: LedgerAttribution | undefined,
    signer: CreateModelClientOptions['requestHeaders'],
  ): Promise<Record<string, string> | undefined> =>
    signer && attribution
      ? signer(attribution)
      : Promise.resolve(undefined)

  // Persist invocations to the durable ledger when the caller supplied
  // attribution and a sink is wired. A ledger failure must never break the model
  // call, so swallow-and-continue (the in-memory tracker still has the totals).
  const ledger = async (
    invocations: LedgerInvocation[],
    attribution: LedgerAttribution | undefined,
  ): Promise<void> => {
    if (!recordUsage || !attribution || invocations.length === 0) {
      return
    }
    try {
      await recordUsage(invocations, attribution)
    } catch {
      // Best-effort operational usage capture; do not fail the originating call.
    }
  }

  const chat: ModelClient['chat'] = async (messages, options) => {
    const attribution = resolveAttribution(options?.usage)
    const headers = await resolveHeaders(attribution, requestHeaders)
    const result = await inferenceService.run({
      maxOutputTokens: options?.maxTokens,
      messages: toProviderMessages(messages),
      model: options?.model,
      promptCacheKey: options?.promptCacheKey,
      reasoningEffort: options?.reasoningEffort,
      responseFormat: options?.responseFormat,
      requestHeaders: headers,
      temperature: options?.temperature,
    })

    for (const invocation of result.invocations) {
      recordUsageFromModel(usageTracker, invocation.model, invocation.usage)
    }
    await ledger(result.invocations, attribution)

    return result.outputText
  }

  const chatJson = async <T = unknown>(
    messages: ModelMessage[],
    options?: ModelOptions,
  ): Promise<T> => {
    const text = await chat(messages, {
      ...options,
      responseFormat: options?.responseFormat ?? { type: 'json_object' },
    })
    return JSON.parse(text) as T
  }

  const embed: ModelClient['embed'] = async (text, options) => {
    const attribution = resolveAttribution(options?.usage)
    const headers = await resolveHeaders(attribution, embeddingSigner)
    const result = await embeddingService.embed(text, {
      model: embedding.model,
      requestHeaders: headers,
    })

    recordUsageFromModel(
      usageTracker,
      result.invocation.model,
      result.invocation.usage,
    )
    await ledger([result.invocation], attribution)

    return result.embedding
  }

  const embedMany: ModelClient['embedMany'] = async (texts, options) => {
    const attribution = resolveAttribution(options?.usage)
    const headers = await resolveHeaders(attribution, embeddingSigner)
    const result = await embeddingService.embedBatch(texts, {
      model: embedding.model,
      requestHeaders: headers,
    })

    recordUsageFromModel(
      usageTracker,
      result.invocation.model,
      result.invocation.usage,
    )
    await ledger([result.invocation], attribution)

    return result.embeddings
  }

  const stream: ModelClient['stream'] = async function* (messages, options) {
    const attribution = resolveAttribution(options?.usage)
    const headers = await resolveHeaders(attribution, requestHeaders)
    const source = inferenceService.stream?.({
      maxOutputTokens: options?.maxTokens,
      messages: toProviderMessages(messages),
      model: options?.model,
      promptCacheKey: options?.promptCacheKey,
      reasoningEffort: options?.reasoningEffort,
      responseFormat: options?.responseFormat,
      requestHeaders: headers,
      temperature: options?.temperature,
    })

    if (!source) {
      const text = await chat(messages, options)
      if (text) {
        yield text
      }
      return
    }

    let next = await source.next()
    while (!next.done) {
      if (next.value.type === 'output_text.delta') {
        yield next.value.text
      }
      next = await source.next()
    }

    for (const invocation of next.value.invocations) {
      recordUsageFromModel(usageTracker, invocation.model, invocation.usage)
    }
    await ledger(next.value.invocations, attribution)
  }

  return {
    chat,
    chatJson,
    close: () => {
      inferenceService.close()
      if (embeddingService !== inferenceService) {
        embeddingService.close()
      }
    },
    embed,
    embeddingModel: embedding.model,
    embedMany,
    fetchCompletion: async (body, fetchOptions) => {
      const attribution = resolveAttribution(fetchOptions?.usage)
      return inferenceService.fetchCompletion(
        body,
        await resolveHeaders(attribution, requestHeaders),
      )
    },
    stream,
    usage: usageTracker,
  }
}
