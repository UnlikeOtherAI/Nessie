import { ModelUsageTracker } from './usage.js'

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

export type ModelProviderName = 'openai' | 'minimax'

export type ModelProviderConfig = {
  apiKey?: string
  modelName?: string
  provider: ModelProviderName
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

// ─── OpenAI response types ──────────────────────────────────────────────────

type OpenAiUsage = {
  prompt_tokens: number
  completion_tokens: number
}

type OpenAiChatResponse = {
  choices: { message: { content: string } }[]
  model: string
  usage?: OpenAiUsage
}

type OpenAiEmbeddingResponse = {
  data: { embedding: number[] }[]
  model: string
  usage?: { prompt_tokens: number; total_tokens: number }
}

// ─── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_OPENAI_MODEL = 'gpt-5-mini'
const DEFAULT_MINIMAX_MODEL = 'MiniMax-M2.5'
const DEFAULT_EMBEDDING_MODEL = 'text-embedding-3-small'
const CONTEXT_PREFIX = 'Context:\n'

// ─── Streaming utilities ────────────────────────────────────────────────────

type StreamResult = {
  usage: OpenAiUsage | null
}

const readTextDeltas = async function* (
  response: Response,
): AsyncGenerator<string, StreamResult, undefined> {
  if (!response.body) {
    throw new Error('Model response has no body')
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let emittedDelta = false
  let fallbackMessageContent = ''
  let capturedUsage: OpenAiUsage | null = null

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        if (!line.startsWith('data: ')) {
          continue
        }

        const data = line.slice(6).trim()
        if (data === '[DONE]') {
          return { usage: capturedUsage }
        }

        try {
          const chunk = JSON.parse(data) as {
            choices?: {
              delta?: { content?: string }
              message?: { content?: string }
            }[]
            usage?: OpenAiUsage
          }

          if (chunk.usage) {
            capturedUsage = chunk.usage
          }

          const deltaText = chunk.choices?.[0]?.delta?.content
          if (deltaText) {
            emittedDelta = true
            yield deltaText
            continue
          }

          const messageContent = chunk.choices?.[0]?.message?.content
          if (messageContent) {
            fallbackMessageContent = messageContent
          }
        } catch {
          // Ignore malformed streaming payloads.
        }
      }
    }
  } finally {
    reader.releaseLock()
  }

  if (!emittedDelta && fallbackMessageContent) {
    yield fallbackMessageContent
  }

  return { usage: capturedUsage }
}

const completeFromStream = async (
  gen: AsyncGenerator<string, StreamResult, undefined>,
): Promise<{ text: string; usage: OpenAiUsage | null }> => {
  let text = ''
  let result = await gen.next()
  while (!result.done) {
    text += result.value
    result = await gen.next()
  }

  return { text, usage: result.value.usage }
}

// ─── MiniMax message normalization ──────────────────────────────────────────

const formatContextBlock = (content: string): string =>
  `${CONTEXT_PREFIX}${content.trim()}`

const normalizeMiniMaxMessages = (
  messages: ModelMessage[],
): ModelMessage[] => {
  const normalized: ModelMessage[] = []
  let pendingSystemContent = ''

  const flushPendingSystem = (): void => {
    if (!pendingSystemContent.trim()) {
      return
    }

    normalized.push({
      content: formatContextBlock(pendingSystemContent),
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
        ? `${formatContextBlock(pendingSystemContent)}\n\n${message.content.trim()}`
        : message.content
      normalized.push({ content, role: 'user' })
      pendingSystemContent = ''
      continue
    }

    flushPendingSystem()
    normalized.push(message)
  }

  flushPendingSystem()
  return normalized
}

// ─── OpenAI client ──────────────────────────────────────────────────────────

const createOpenAiClient = (
  apiKey: string,
  modelName: string | undefined,
  tracker: ModelUsageTracker,
): ModelClient => {
  const baseUrl = 'https://api.openai.com/v1'
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  }

  const resolveModel = (options?: ModelOptions | EmbedOptions): string =>
    ('model' in (options ?? {}) ? (options as ModelOptions).model : undefined) ??
    modelName ??
    DEFAULT_OPENAI_MODEL

  const fetchCompletion: ModelClient['fetchCompletion'] = async (body) => {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`OpenAI model error ${response.status}: ${errorText}`)
    }

    return response
  }

  const stream: ModelClient['stream'] = async function* (messages, options) {
    const model = resolveModel(options)
    const body: Record<string, unknown> = {
      max_completion_tokens: options?.maxTokens ?? 1024,
      messages,
      model,
      stream: true,
      stream_options: { include_usage: true },
    }
    if (options?.temperature !== undefined) {
      body.temperature = options.temperature
    }
    if (options?.responseFormat) {
      body.response_format = options.responseFormat
    }

    const response = await fetchCompletion(body)
    const gen = readTextDeltas(response)
    let result = await gen.next()
    while (!result.done) {
      yield result.value
      result = await gen.next()
    }

    const usage = result.value.usage
    if (usage) {
      tracker.record(model, usage.prompt_tokens, usage.completion_tokens)
    }
  }

  const chat: ModelClient['chat'] = async (messages, options) => {
    const model = resolveModel(options)
    const body: Record<string, unknown> = {
      max_completion_tokens: options?.maxTokens ?? 1024,
      messages,
      model,
    }
    if (options?.temperature !== undefined) {
      body.temperature = options.temperature
    }
    if (options?.responseFormat) {
      body.response_format = options.responseFormat
    }

    const response = await fetchCompletion(body)
    const json = (await response.json()) as OpenAiChatResponse

    if (json.usage) {
      tracker.record(
        json.model ?? model,
        json.usage.prompt_tokens,
        json.usage.completion_tokens,
      )
    }

    return json.choices[0]?.message.content ?? ''
  }

  const chatJson: ModelClient['chatJson'] = async (messages, options) => {
    const text = await chat(messages, {
      ...options,
      responseFormat: options?.responseFormat ?? { type: 'json_object' },
    })
    return JSON.parse(text) as never
  }

  const embed: ModelClient['embed'] = async (text, options) => {
    const model = options?.model ?? DEFAULT_EMBEDDING_MODEL
    const response = await fetch(`${baseUrl}/embeddings`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        input: text.slice(0, 8000),
        model,
      }),
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`OpenAI embedding error ${response.status}: ${errorText}`)
    }

    const json = (await response.json()) as OpenAiEmbeddingResponse

    if (json.usage) {
      tracker.record(
        json.model ?? model,
        json.usage.prompt_tokens,
        0,
      )
    }

    const embedding = json.data[0]?.embedding
    if (!embedding) {
      throw new Error('No embedding returned from API')
    }

    return embedding
  }

  return {
    chat,
    chatJson,
    close: () => undefined,
    embed,
    fetchCompletion,
    stream,
    usage: tracker,
  }
}

// ─── MiniMax client ─────────────────────────────────────────────────────────

const createMiniMaxClient = (
  apiKey: string,
  modelName: string | undefined,
  tracker: ModelUsageTracker,
): ModelClient => {
  const baseUrl = 'https://api.minimax.io/v1'
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  }

  const resolveModel = (options?: ModelOptions): string =>
    options?.model ?? modelName ?? DEFAULT_MINIMAX_MODEL

  const fetchCompletion: ModelClient['fetchCompletion'] = async (body) => {
    const response = await fetch(`${baseUrl}/text/chatcompletion_v2`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`MiniMax model error ${response.status}: ${errorText}`)
    }

    return response
  }

  const stream: ModelClient['stream'] = async function* (messages, options) {
    const model = resolveModel(options)
    const body: Record<string, unknown> = {
      max_completion_tokens: options?.maxTokens ?? 1024,
      messages: normalizeMiniMaxMessages(messages),
      model,
      stream: true,
    }
    if (options?.temperature !== undefined) {
      body.temperature = options.temperature
    }

    const response = await fetchCompletion(body)
    const gen = readTextDeltas(response)
    let result = await gen.next()
    while (!result.done) {
      yield result.value
      result = await gen.next()
    }

    const usage = result.value.usage
    if (usage) {
      tracker.record(model, usage.prompt_tokens, usage.completion_tokens)
    }
  }

  const streamInternal = async function* (
    messages: ModelMessage[],
    options?: ModelOptions,
  ): AsyncGenerator<string, StreamResult, undefined> {
    const model = resolveModel(options)
    const body: Record<string, unknown> = {
      max_completion_tokens: options?.maxTokens ?? 1024,
      messages: normalizeMiniMaxMessages(messages),
      model,
      stream: true,
    }
    if (options?.temperature !== undefined) {
      body.temperature = options.temperature
    }

    const response = await fetchCompletion(body)
    const gen = readTextDeltas(response)
    let result = await gen.next()
    while (!result.done) {
      yield result.value
      result = await gen.next()
    }

    const usage = result.value.usage
    if (usage) {
      tracker.record(model, usage.prompt_tokens, usage.completion_tokens)
    }

    return result.value
  }

  const chat: ModelClient['chat'] = async (messages, options) => {
    const { text } = await completeFromStream(streamInternal(messages, options))
    return text
  }

  const chatJson: ModelClient['chatJson'] = async (messages, options) => {
    const text = await chat(messages, options)
    return JSON.parse(text) as never
  }

  const embed: ModelClient['embed'] = async () => {
    throw new Error('MiniMax does not support embeddings — use OpenAI provider')
  }

  return {
    chat,
    chatJson,
    close: () => undefined,
    embed,
    fetchCompletion,
    stream,
    usage: tracker,
  }
}

// ─── Factory ────────────────────────────────────────────────────────────────

export const createModelClient = (
  config: ModelProviderConfig,
  tracker?: ModelUsageTracker,
): ModelClient => {
  const usageTracker = tracker ?? new ModelUsageTracker()

  if (config.provider === 'minimax') {
    if (!config.apiKey) {
      throw new Error('MINIMAX_API_KEY is not set')
    }

    return createMiniMaxClient(config.apiKey, config.modelName, usageTracker)
  }

  if (!config.apiKey) {
    throw new Error('OPENAI_API_KEY / OPENAI_CHAT_API_KEY is not set')
  }

  return createOpenAiClient(config.apiKey, config.modelName, usageTracker)
}
