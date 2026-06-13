import type {
  InvocationUsage,
  NormalizedFinishReason,
  ProviderMessage,
  ProviderToolCall,
  ToolSchemaDescriptor,
} from '../types.js'
import {
  registerStreamReaderCleanup,
  releaseStreamReader,
  type ProviderStreamCapture,
} from './stream-readers.js'

export type OpenAiUsage = {
  completion_tokens: number
  prompt_tokens: number
  total_tokens?: number
  // OpenAI automatic prompt caching: the cached subset of prompt_tokens, billed
  // at a discount. prompt_tokens INCLUDES this value.
  prompt_tokens_details?: { cached_tokens?: number }
}

export type OpenAiChatResponse = {
  choices?: Array<{
    finish_reason?: string | null
    message?: {
      content?: string | null
      tool_calls?: Array<{
        id: string
        type: 'function'
        function: { name: string; arguments: string }
      }>
    }
  }>
  model?: string
  usage?: OpenAiUsage
}

export type OpenAiEmbeddingResponse = {
  data?: Array<{ embedding?: number[] }>
  model?: string
  usage?: {
    prompt_tokens: number
    total_tokens?: number
  }
}

type OpenAiStreamChunk = {
  choices?: Array<{
    delta?: {
      content?: string | null
      reasoning_content?: string | null
      tool_calls?: Array<{
        index: number
        id?: string
        type?: 'function'
        function?: { name?: string; arguments?: string }
      }>
    }
    finish_reason?: string | null
    message?: { content?: string | null }
  }>
  usage?: OpenAiUsage
}

export const DEFAULT_OPENAI_MODEL = 'gpt-5-mini'
export const DEFAULT_EMBEDDING_MODEL = 'text-embedding-3-small'

// OpenAI reasoning-era models (gpt-5 family, o1/o3/o4) only accept the
// default temperature. Sending any other value returns HTTP 400
// "Unsupported value: 'temperature' does not support X with this model".
// We drop the field for those models so callers can pass temperature
// freely without having to know the provider matrix.
const OPENAI_REASONING_MODEL_PREFIX_RE = /^(?:gpt-5|o1|o3|o4)(?:[-_]|$)/i

export const resolveOpenAiTemperature = (
  model: string,
  temperature: number | undefined,
): number | undefined =>
  OPENAI_REASONING_MODEL_PREFIX_RE.test(model) ? undefined : temperature

const safeParseJson = (raw: string): Record<string, unknown> => {
  try {
    return JSON.parse(raw) as Record<string, unknown>
  } catch {
    return { _raw: raw }
  }
}

export const normalizeFinishReason = (
  value: string | null | undefined,
): NormalizedFinishReason | undefined => {
  if (!value) {
    return undefined
  }

  switch (value) {
    case 'content_filter':
      return 'content-filter'
    case 'length':
      return 'length'
    case 'stop':
      return 'stop'
    case 'tool_calls':
    case 'tool_call':
      return 'tool-call'
    default:
      return 'other'
  }
}

export const usageFromOpenAi = (
  usage: OpenAiUsage | undefined,
): InvocationUsage => {
  if (!usage) {
    return {}
  }

  // OpenAI's prompt_tokens INCLUDES cached tokens; split them so the cached
  // portion is billed at the (cheaper) cache-read rate and the cache-hit rate
  // is observable instead of silently billed at full input price.
  const cachedTokens = usage.prompt_tokens_details?.cached_tokens ?? 0
  const nonCachedInput = Math.max(0, usage.prompt_tokens - cachedTokens)

  return {
    inputTokens: nonCachedInput,
    outputTokens: usage.completion_tokens,
    ...(cachedTokens > 0 ? { cacheReadTokens: cachedTokens } : {}),
    totalTokens:
      usage.total_tokens
      ?? usage.prompt_tokens + usage.completion_tokens,
  }
}

export const embeddingUsageFromOpenAi = (
  usage: OpenAiEmbeddingResponse['usage'],
): InvocationUsage => {
  if (!usage) {
    return {}
  }

  return {
    inputTokens: usage.prompt_tokens,
    outputTokens: 0,
    totalTokens: usage.total_tokens ?? usage.prompt_tokens,
  }
}

export const collectChatStream = async function* (
  response: Response,
): ProviderStreamCapture {
  if (!response.body) {
    throw new Error('Model response has no body')
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let fallbackMessageContent = ''
  let finishReason: NormalizedFinishReason | undefined
  let outputText = ''
  const toolCalls = new Map<number, { args: string; id: string; name: string }>()
  let usage: InvocationUsage = {}
  let yieldedDelta = false

  const cleanupToken = registerStreamReaderCleanup(reader)

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const rawLine of lines) {
        const line = rawLine.trim()
        if (!line.startsWith('data: ')) {
          continue
        }

        const data = line.slice(6).trim()
        if (data === '[DONE]') {
          return {
            finishReason,
            outputText,
            toolCalls: Array.from(toolCalls.entries())
              .sort(([left], [right]) => left - right)
              .map(([, value]) => ({
                arguments: safeParseJson(value.args),
                toolCallId: value.id,
                toolName: value.name,
              })),
            usage,
          }
        }

        try {
          const chunk = JSON.parse(data) as OpenAiStreamChunk
          const choice = chunk.choices?.[0]

          if (chunk.usage) {
            usage = usageFromOpenAi(chunk.usage)
          }

          if (choice?.finish_reason) {
            finishReason = normalizeFinishReason(choice.finish_reason)
          }

          const deltaText = choice?.delta?.content ?? ''
          const reasoningText = choice?.delta?.reasoning_content ?? ''
          if (reasoningText) {
            yield { type: 'reasoning_text.delta', text: reasoningText }
          }

          if (deltaText) {
            yieldedDelta = true
            outputText += deltaText
            yield { type: 'output_text.delta', text: deltaText }
            continue
          }

          for (const toolCallDelta of choice?.delta?.tool_calls ?? []) {
            const existing = toolCalls.get(toolCallDelta.index) ?? {
              args: '',
              id: '',
              name: '',
            }

            if (toolCallDelta.id) {
              existing.id = toolCallDelta.id
            }

            if (toolCallDelta.function?.name) {
              existing.name = toolCallDelta.function.name
            }

            if (toolCallDelta.function?.arguments) {
              existing.args += toolCallDelta.function.arguments
              yield {
                type: 'tool_call.delta',
                text: toolCallDelta.function.arguments,
              }
            }

            toolCalls.set(toolCallDelta.index, existing)
          }

          const messageText = choice?.message?.content ?? ''
          if (messageText) {
            fallbackMessageContent = messageText
          }
        } catch {
          // Ignore malformed SSE chunks and continue consuming the stream.
        }
      }
    }
  } finally {
    await releaseStreamReader(reader, cleanupToken)
  }

  if (!yieldedDelta && fallbackMessageContent) {
    outputText = fallbackMessageContent
    yield { type: 'output_text.delta', text: fallbackMessageContent }
  }

  return {
    finishReason,
    outputText,
    toolCalls: Array.from(toolCalls.entries())
      .sort(([left], [right]) => left - right)
      .map(([, value]) => ({
        arguments: safeParseJson(value.args),
        toolCallId: value.id,
        toolName: value.name,
      })),
    usage,
  }
}

export const mapToolsToOpenAi = (
  tools: ToolSchemaDescriptor[] | undefined,
):
  | Array<{
    type: 'function'
    function: {
      name: string
      description: string
      parameters: Record<string, unknown>
    }
  }>
  | undefined =>
  tools?.map((tool) => ({
    function: {
      description: tool.description,
      name: tool.toolName,
      parameters: tool.inputSchema,
    },
    type: 'function',
  }))

export const mapToolCallsFromOpenAi = (
  toolCalls:
    | Array<{
      id: string
      type: 'function'
      function: { name: string; arguments: string }
    }>
    | undefined,
): ProviderToolCall[] =>
  (toolCalls ?? []).map((toolCall) => ({
    arguments: safeParseJson(toolCall.function.arguments),
    toolCallId: toolCall.id,
    toolName: toolCall.function.name,
  }))

export const mapMessagesToOpenAi = (
  messages: ProviderMessage[],
): Array<Record<string, unknown>> =>
  messages.map((message) => {
    if (message.role === 'assistant') {
      return {
        content: message.content ?? '',
        role: 'assistant',
        tool_calls: message.toolCalls?.map((toolCall) => ({
          function: {
            arguments: JSON.stringify(toolCall.arguments),
            name: toolCall.toolName,
          },
          id: toolCall.toolCallId,
          type: 'function',
        })),
      }
    }

    if (message.role === 'tool') {
      return {
        content: message.content,
        role: 'tool',
        tool_call_id: message.toolCallId,
      }
    }

    return message
  })
