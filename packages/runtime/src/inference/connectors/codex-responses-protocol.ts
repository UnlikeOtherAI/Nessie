import type {
  InvocationUsage,
  NormalizedFinishReason,
  ProviderMessage,
  ProviderStreamEvent,
  ProviderToolCall,
  ToolSchemaDescriptor,
} from '../types.js'
import {
  registerStreamReaderCleanup,
  releaseStreamReader,
} from './stream-readers.js'

/**
 * Wire mapping for ChatGPT's Codex backend, which speaks the **Responses** API
 * rather than chat/completions.
 *
 * It is a separate protocol module for the same reason the Anthropic mapping is:
 * the message shape, the streaming event names, and the tool-call envelope all
 * differ. What it deliberately does NOT change is the event vocabulary it emits
 * — `output_text.delta`, `tool_call.delta`, `reasoning_text.delta` — so the
 * agentic loop, the thinking recorder and live document streaming see exactly
 * what they see from every other connector.
 */

export const DEFAULT_CODEX_MODEL = 'gpt-5-codex'

/** A Responses `input` item. Tool results are their own item type here. */
type CodexInputItem =
  | { role: 'user' | 'assistant'; content: Array<Record<string, unknown>> }
  | { type: 'function_call'; call_id: string; name: string; arguments: string }
  | { type: 'function_call_output'; call_id: string; output: string }

export type CodexRequestBody = {
  input: CodexInputItem[]
  instructions?: string
  model: string
  store: false
  stream: boolean
  tools?: Array<Record<string, unknown>>
  tool_choice?: unknown
  max_output_tokens?: number
  reasoning?: { effort: string }
}

/**
 * Fold Nessie's provider messages into a Responses request.
 *
 * System turns become `instructions` (the Responses API's own slot for them)
 * rather than a pseudo-message, and an assistant turn carrying tool calls
 * expands into one `function_call` item per call — the shape the backend
 * echoes back, so a replayed transcript round-trips.
 */
export const mapMessagesToCodex = (
  messages: ProviderMessage[],
  options: { vision: boolean },
): { input: CodexInputItem[]; instructions?: string } => {
  const instructions: string[] = []
  const input: CodexInputItem[] = []

  for (const message of messages) {
    if (message.role === 'system') {
      instructions.push(message.content)
      continue
    }
    if (message.role === 'tool') {
      input.push({
        call_id: message.toolCallId,
        output: message.content,
        type: 'function_call_output',
      })
      continue
    }
    if (message.role === 'assistant') {
      if (message.content) {
        input.push({
          content: [{ text: message.content, type: 'output_text' }],
          role: 'assistant',
        })
      }
      for (const call of message.toolCalls ?? []) {
        input.push({
          arguments: JSON.stringify(call.arguments ?? {}),
          call_id: call.toolCallId,
          name: call.toolName,
          type: 'function_call',
        })
      }
      continue
    }
    const parts: Array<Record<string, unknown>> = [
      { text: message.content, type: 'input_text' },
    ]
    if (options.vision) {
      for (const image of message.images ?? []) {
        parts.push({
          image_url: `data:${image.mime};base64,${image.dataBase64}`,
          type: 'input_image',
        })
      }
    }
    input.push({ content: parts, role: 'user' })
  }

  return {
    input,
    ...(instructions.length > 0 ? { instructions: instructions.join('\n\n') } : {}),
  }
}

/** Responses tools are flat, not nested under a `function` key. */
export const mapToolsToCodex = (
  tools: ToolSchemaDescriptor[] | undefined,
): Array<Record<string, unknown>> | undefined =>
  tools && tools.length > 0
    ? tools.map((tool) => ({
      description: tool.description,
      name: tool.toolName,
      parameters: tool.inputSchema,
      type: 'function',
    }))
    : undefined

export const usageFromCodex = (usage: unknown): InvocationUsage => {
  const record = (usage ?? {}) as Record<string, unknown>
  const details = (record.input_tokens_details ?? {}) as Record<string, unknown>
  const num = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) ? value : undefined
  return {
    cacheReadTokens: num(details.cached_tokens),
    cachedInputTokens: num(details.cached_tokens),
    inputTokens: num(record.input_tokens),
    outputTokens: num(record.output_tokens),
    totalTokens: num(record.total_tokens),
  }
}

const finishReasonFromStatus = (
  status: unknown,
  hasToolCalls: boolean,
): NormalizedFinishReason => {
  if (hasToolCalls) return 'tool-call'
  if (status === 'incomplete') return 'length'
  if (status === 'failed') return 'error'
  return 'stop'
}

type PendingCall = { arguments: string; id: string; index: number; name: string }

export type CodexStreamResult = {
  finishReason: NormalizedFinishReason
  outputText: string
  toolCalls: ProviderToolCall[]
  usage: InvocationUsage
}

/**
 * Read one Responses SSE stream.
 *
 * Tool-call fragments are enriched from the accumulated call rather than the
 * chunk that carried them — the Responses API announces a function call's name
 * and `call_id` in `response.output_item.added`, and every later fragment
 * carries only the item id. This is the same correction the OpenAI-compatible
 * connector needed, for the same reason: a consumer streaming arguments must
 * always know which call they belong to.
 */
export async function* collectCodexStream(
  response: Response,
): AsyncGenerator<ProviderStreamEvent, CodexStreamResult, undefined> {
  if (!response.body) {
    throw new Error('Model response has no body')
  }

  const callsByItemId = new Map<string, PendingCall>()
  let outputText = ''
  let usage: InvocationUsage = {}
  let status: unknown = 'completed'
  let nextIndex = 0

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const cleanupToken = registerStreamReaderCleanup(reader)

  const handle = function* (
    event: Record<string, unknown>,
  ): Generator<ProviderStreamEvent, void, undefined> {
    const type = typeof event.type === 'string' ? event.type : ''

    if (type === 'response.output_text.delta') {
      const delta = typeof event.delta === 'string' ? event.delta : ''
      if (delta) {
        outputText += delta
        yield { text: delta, type: 'output_text.delta' }
      }
      return
    }

    if (
      type === 'response.reasoning_summary_text.delta'
      || type === 'response.reasoning_text.delta'
    ) {
      const delta = typeof event.delta === 'string' ? event.delta : ''
      if (delta) yield { text: delta, type: 'reasoning_text.delta' }
      return
    }

    if (type === 'response.output_item.added') {
      const item = (event.item ?? {}) as Record<string, unknown>
      if (item.type === 'function_call') {
        const itemId = typeof item.id === 'string' ? item.id : ''
        const callId = typeof item.call_id === 'string' ? item.call_id : itemId
        const name = typeof item.name === 'string' ? item.name : ''
        if (itemId && name) {
          callsByItemId.set(itemId, {
            arguments: '',
            id: callId,
            index: nextIndex++,
            name,
          })
        }
      }
      return
    }

    if (type === 'response.function_call_arguments.delta') {
      const itemId = typeof event.item_id === 'string' ? event.item_id : ''
      const delta = typeof event.delta === 'string' ? event.delta : ''
      const pending = callsByItemId.get(itemId)
      if (!pending || !delta) return
      pending.arguments += delta
      yield {
        id: pending.id,
        index: pending.index,
        text: delta,
        toolName: pending.name,
        type: 'tool_call.delta',
      }
      return
    }

    if (
      type === 'response.completed'
      || type === 'response.incomplete'
      || type === 'response.failed'
    ) {
      const body = (event.response ?? {}) as Record<string, unknown>
      usage = usageFromCodex(body.usage)
      status = body.status ?? (type === 'response.completed' ? 'completed' : 'incomplete')
      return
    }

    if (type === 'error' || type === 'response.error') {
      const message = typeof event.message === 'string'
        ? event.message
        : 'The model stream failed.'
      yield { message, retryable: true, type: 'response.error' }
    }
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const rawLine of lines) {
        const line = rawLine.trim()
        if (!line.startsWith('data:')) continue
        const data = line.slice(5).trim()
        if (data.length === 0 || data === '[DONE]') continue

        let event: Record<string, unknown>
        try {
          event = JSON.parse(data) as Record<string, unknown>
        } catch {
          continue
        }
        yield* handle(event)
      }
    }
  } finally {
    await releaseStreamReader(reader, cleanupToken)
  }

  const toolCalls: ProviderToolCall[] = [...callsByItemId.values()]
    .sort((left, right) => left.index - right.index)
    .map((call) => ({
      arguments: parseArguments(call.arguments),
      toolCallId: call.id,
      toolName: call.name,
    }))

  return {
    finishReason: finishReasonFromStatus(status, toolCalls.length > 0),
    outputText,
    toolCalls,
    usage,
  }
}

const parseArguments = (raw: string): Record<string, unknown> => {
  if (!raw.trim()) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** Non-streaming read of a completed Responses body. */
export const readCodexResponse = (body: Record<string, unknown>): CodexStreamResult => {
  const output = Array.isArray(body.output) ? (body.output as Record<string, unknown>[]) : []
  let outputText = ''
  const toolCalls: ProviderToolCall[] = []

  for (const item of output) {
    if (item.type === 'message') {
      const content = Array.isArray(item.content)
        ? (item.content as Record<string, unknown>[])
        : []
      for (const part of content) {
        if (part.type === 'output_text' && typeof part.text === 'string') {
          outputText += part.text
        }
      }
      continue
    }
    if (item.type === 'function_call') {
      const callId = typeof item.call_id === 'string'
        ? item.call_id
        : typeof item.id === 'string' ? item.id : ''
      const name = typeof item.name === 'string' ? item.name : ''
      if (callId && name) {
        toolCalls.push({
          arguments: parseArguments(typeof item.arguments === 'string' ? item.arguments : ''),
          toolCallId: callId,
          toolName: name,
        })
      }
    }
  }

  return {
    finishReason: finishReasonFromStatus(body.status, toolCalls.length > 0),
    outputText,
    toolCalls,
    usage: usageFromCodex(body.usage),
  }
}
