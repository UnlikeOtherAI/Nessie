import { createInferenceService } from './inference/service.js'
import type {
  ModelProviderConfig,
  ProviderMessage,
} from './inference/types.js'
import { ModelUsageTracker } from './usage.js'

export type { ModelProviderConfig, ModelProviderName } from './inference/types.js'

export type ModelMessage = {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export type ModelOptions = {
  maxTokens?: number
  model?: string
  temperature?: number
  responseFormat?: { type: 'json_object' }
}

export type EmbedOptions = {
  model?: string
}

export interface ModelClient {
  chat(messages: ModelMessage[], options?: ModelOptions): Promise<string>
  chatJson<T = unknown>(messages: ModelMessage[], options?: ModelOptions): Promise<T>
  embed(text: string, options?: EmbedOptions): Promise<number[]>
  stream(
    messages: ModelMessage[],
    options?: ModelOptions,
  ): AsyncGenerator<string, void, undefined>
  fetchCompletion(body: Record<string, unknown>): Promise<Response>
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
  tracker?: ModelUsageTracker,
): ModelClient => {
  const usageTracker = tracker ?? new ModelUsageTracker()
  const inferenceService = createInferenceService(config)

  const chat: ModelClient['chat'] = async (messages, options) => {
    const result = await inferenceService.run({
      maxOutputTokens: options?.maxTokens,
      messages: toProviderMessages(messages),
      model: options?.model,
      responseFormat: options?.responseFormat,
      temperature: options?.temperature,
    })

    for (const invocation of result.invocations) {
      recordUsageFromModel(usageTracker, invocation.model, invocation.usage)
    }

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
    const result = await inferenceService.embed(text, {
      model: options?.model,
    })

    recordUsageFromModel(
      usageTracker,
      result.invocation.model,
      result.invocation.usage,
    )

    return result.embedding
  }

  const stream: ModelClient['stream'] = async function* (messages, options) {
    const source = inferenceService.stream?.({
      maxOutputTokens: options?.maxTokens,
      messages: toProviderMessages(messages),
      model: options?.model,
      responseFormat: options?.responseFormat,
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
  }

  return {
    chat,
    chatJson,
    close: () => {
      inferenceService.close()
    },
    embed,
    fetchCompletion: (body) => inferenceService.fetchCompletion(body),
    stream,
    usage: usageTracker,
  }
}
