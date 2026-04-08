export type ModelMessage = {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export type ModelOptions = {
  maxTokens?: number
  model?: string
  temperature?: number
}

export type ModelProviderName = 'openai' | 'minimax'

export type ModelProviderConfig = {
  apiKey?: string
  modelName?: string
  provider: ModelProviderName
}

export interface ModelClient {
  chat(messages: ModelMessage[], options?: ModelOptions): Promise<string>
  close(): void
  stream(messages: ModelMessage[], options?: ModelOptions): AsyncGenerator<string, void, undefined>
}

const DEFAULT_OPENAI_MODEL = 'gpt-4o'
const DEFAULT_MINIMAX_MODEL = 'MiniMax-M2.5'
const CONTEXT_PREFIX = 'Context:\n'

const readTextDeltas = async function* (
  response: Response,
): AsyncGenerator<string, void, undefined> {
  if (!response.body) {
    throw new Error('Model response has no body')
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let emittedDelta = false
  let fallbackMessageContent = ''

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
          return
        }

        try {
          const chunk = JSON.parse(data) as {
            choices?: { delta?: { content?: string }; message?: { content?: string } }[]
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
}

const completeFromStream = async (
  stream: AsyncGenerator<string, void, undefined>,
): Promise<string> => {
  let text = ''
  for await (const delta of stream) {
    text += delta
  }

  return text
}

const formatContextBlock = (content: string): string => `${CONTEXT_PREFIX}${content.trim()}`

const normalizeMiniMaxMessages = (messages: ModelMessage[]): ModelMessage[] => {
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
      normalized.push({
        content,
        role: 'user',
      })
      pendingSystemContent = ''
      continue
    }

    flushPendingSystem()
    normalized.push(message)
  }

  flushPendingSystem()
  return normalized
}

const createOpenAiClient = (apiKey: string, modelName?: string): ModelClient => {
  const stream: ModelClient['stream'] = async function* (messages, options) {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        max_tokens: options?.maxTokens ?? 1024,
        messages,
        model: options?.model ?? modelName ?? DEFAULT_OPENAI_MODEL,
        temperature: options?.temperature ?? 0.7,
        stream: true,
      }),
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`OpenAI model error ${response.status}: ${errorText}`)
    }

    yield* readTextDeltas(response)
  }

  return {
    chat: async (messages, options) => completeFromStream(stream(messages, options)),
    close: () => undefined,
    stream,
  }
}

const createMiniMaxClient = (apiKey: string, modelName?: string): ModelClient => {
  const stream: ModelClient['stream'] = async function* (messages, options) {
    const response = await fetch('https://api.minimax.io/v1/text/chatcompletion_v2', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        max_completion_tokens: options?.maxTokens ?? 1024,
        messages: normalizeMiniMaxMessages(messages),
        model: options?.model ?? modelName ?? DEFAULT_MINIMAX_MODEL,
        temperature: options?.temperature ?? 0.7,
        stream: true,
      }),
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`MiniMax model error ${response.status}: ${errorText}`)
    }

    yield* readTextDeltas(response)
  }

  return {
    chat: async (messages, options) => completeFromStream(stream(messages, options)),
    close: () => undefined,
    stream,
  }
}

export const createModelClient = (config: ModelProviderConfig): ModelClient => {
  if (config.provider === 'minimax') {
    if (!config.apiKey) {
      throw new Error('MINIMAX_API_KEY is not set')
    }

    return createMiniMaxClient(config.apiKey, config.modelName)
  }

  if (!config.apiKey) {
    throw new Error('OPENAI_API_KEY / OPENAI_CHAT_API_KEY is not set')
  }

  return createOpenAiClient(config.apiKey, config.modelName)
}
