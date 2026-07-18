import { createInferenceService } from './inference/service.js'
import type {
  ModelProviderConfig,
  ProviderMessage,
} from './inference/types.js'
import type { LedgerAttribution, LedgerInvocation } from './ledger.js'
import { completeLedgerAttribution } from './ledger-attribution.js'
import { ModelUsageTracker } from './usage.js'

export type { ModelProviderConfig, ModelProviderName } from './inference/types.js'

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
  usage?: LedgerAttribution
}

export type EmbedOptions = {
  model?: string
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
}

export interface ModelClient {
  chat(messages: ModelMessage[], options?: ModelOptions): Promise<string>
  chatJson<T = unknown>(messages: ModelMessage[], options?: ModelOptions): Promise<T>
  embed(text: string, options?: EmbedOptions): Promise<number[]>
  embedMany(texts: string[], options?: EmbedOptions): Promise<number[][]>
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
  ): Promise<Record<string, string> | undefined> =>
    requestHeaders && attribution
      ? requestHeaders(attribution)
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
      // best-effort billing capture; do not fail the originating call
    }
  }

  const chat: ModelClient['chat'] = async (messages, options) => {
    const attribution = resolveAttribution(options?.usage)
    const headers = await resolveHeaders(attribution)
    const result = await inferenceService.run({
      maxOutputTokens: options?.maxTokens,
      messages: toProviderMessages(messages),
      model: options?.model,
      promptCacheKey: options?.promptCacheKey,
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
    const headers = await resolveHeaders(attribution)
    const result = await inferenceService.embed(text, {
      model: options?.model,
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
    const headers = await resolveHeaders(attribution)
    const result = await inferenceService.embedBatch(texts, {
      model: options?.model,
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
    const headers = await resolveHeaders(attribution)
    const source = inferenceService.stream?.({
      maxOutputTokens: options?.maxTokens,
      messages: toProviderMessages(messages),
      model: options?.model,
      promptCacheKey: options?.promptCacheKey,
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
    },
    embed,
    embedMany,
    fetchCompletion: async (body, fetchOptions) => {
      const attribution = resolveAttribution(fetchOptions?.usage)
      return inferenceService.fetchCompletion(
        body,
        await resolveHeaders(attribution),
      )
    },
    stream,
    usage: usageTracker,
  }
}
