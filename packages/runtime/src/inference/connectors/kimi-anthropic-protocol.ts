import type {
  InvocationUsage,
  NormalizedFinishReason,
  ProviderToolCall,
} from '../types.js'
import {
  registerStreamReaderCleanup,
  releaseStreamReader,
  type ProviderStreamCapture,
} from './stream-readers.js'

type AnthropicContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking?: string }
  | { type: string; [key: string]: unknown }

export type AnthropicMessagesResponse = {
  id: string
  type: 'message'
  role: 'assistant'
  content: AnthropicContentBlock[]
  model: string
  stop_reason?: string | null
  usage?: {
    input_tokens?: number
    output_tokens?: number
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
    // Anthropic-style cache accounting (reported separately from input_tokens).
    cache_read_input_tokens?: number
    cache_creation_input_tokens?: number
    // Kimi-style cache accounting (a subset of prompt_tokens).
    cached_tokens?: number
  }
}

type AnthropicStreamEvent =
  | { type: 'message_start'; message: AnthropicMessagesResponse }
  | {
      type: 'content_block_start'
      index: number
      content_block: AnthropicContentBlock
    }
  | {
      type: 'content_block_delta'
      index: number
      delta:
        | { type: 'text_delta'; text: string }
        | { type: 'thinking_delta'; thinking: string }
        | { type: 'input_json_delta'; partial_json: string }
    }
  | { type: 'content_block_stop'; index: number }
  | {
      type: 'message_delta'
      delta: { stop_reason?: string }
      usage?: AnthropicMessagesResponse['usage']
    }
  | { type: 'message_stop' }
  | { type: 'ping' }
  | { type: 'error'; error?: { message?: string } }

export const normalizeAnthropicFinishReason = (
  value: string | null | undefined,
): NormalizedFinishReason | undefined => {
  if (!value) {
    return undefined
  }
  switch (value) {
    case 'end_turn':
    case 'stop_sequence':
      return 'stop'
    case 'max_tokens':
      return 'length'
    case 'tool_use':
      return 'tool-call'
    default:
      return 'other'
  }
}

export const usageFromAnthropic = (
  usage: AnthropicMessagesResponse['usage'],
): InvocationUsage => {
  if (!usage) {
    return {}
  }
  const output = usage.output_tokens ?? usage.completion_tokens ?? 0
  const cacheRead = usage.cache_read_input_tokens ?? usage.cached_tokens ?? 0
  const cacheWrite = usage.cache_creation_input_tokens ?? 0
  const rawInput = usage.input_tokens ?? usage.prompt_tokens ?? 0
  // Anthropic reports cache_read_input_tokens separately from input_tokens; Kimi
  // reports cached_tokens as a subset of prompt_tokens. Only subtract in the
  // subset case so non-cached input is counted exactly once.
  const subsetCache = usage.cache_read_input_tokens === undefined && usage.cached_tokens !== undefined
  const input = subsetCache ? Math.max(0, rawInput - cacheRead) : rawInput
  return {
    inputTokens: input,
    outputTokens: output,
    ...(cacheRead > 0 ? { cacheReadTokens: cacheRead } : {}),
    ...(cacheWrite > 0 ? { cacheWriteTokens: cacheWrite } : {}),
    totalTokens: usage.total_tokens ?? input + cacheRead + cacheWrite + output,
  }
}

const TOOL_USE_OPEN = '<tool_use>'
const TOOL_USE_CLOSE = '</tool_use>'

/**
 * The end of the JSON object that starts at `start` (a `{`), or -1 when the
 * text ends before its braces balance. String-aware, so a brace inside an
 * argument value does not end the object early.
 */
const balancedObjectEnd = (text: string, start: number): number => {
  let depth = 0
  let inString = false
  for (let index = start; index < text.length; index += 1) {
    const char = text[index]
    if (inString) {
      if (char === '\\') index += 1
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return -1
}

const toolCallFromJson = (
  json: string,
  toolCallId: string,
): ProviderToolCall | undefined => {
  try {
    const parsed = JSON.parse(json) as { name?: unknown; arguments?: unknown }
    if (typeof parsed.name !== 'string' || !parsed.name) return undefined
    return {
      arguments: parsed.arguments && typeof parsed.arguments === 'object' && !Array.isArray(parsed.arguments)
        ? parsed.arguments as Record<string, unknown>
        : {},
      toolCallId,
      toolName: parsed.name,
    }
  } catch {
    return undefined
  }
}

/**
 * Lift the model's text-form tool calls out of its answer.
 *
 * Kimi K2.7 ends a turn right after the block's JSON more often than not —
 * production's CTO agent delivered a raw
 * `<tool_use>{"name":"task_set_processors","arguments":{}}` to a person on
 * 2026-09-22 because the closing tag never arrived and the old regex needed
 * it. A block is therefore read by its balanced JSON, with the closing tag
 * optional, and every `<tool_use>` fragment — parsed, malformed or cut off —
 * is removed from the delivered text: protocol never reaches a person. A cut
 * block that never balanced is dropped; the loop's empty-output recovery then
 * asks the model again rather than presenting garbage as an answer.
 */
export const parseKimiToolCalls = (
  text: string,
  requestId: string,
): { outputText: string; toolCalls: ProviderToolCall[] } => {
  const toolCalls: ProviderToolCall[] = []
  let outputText = ''
  let cursor = 0
  for (;;) {
    const open = text.indexOf(TOOL_USE_OPEN, cursor)
    if (open < 0) {
      outputText += text.slice(cursor)
      break
    }
    outputText += text.slice(cursor, open)
    const objectStart = text.indexOf('{', open + TOOL_USE_OPEN.length)
    const between = objectStart < 0 ? '' : text.slice(open + TOOL_USE_OPEN.length, objectStart)
    if (objectStart < 0 || between.trim() !== '') {
      // An opening tag with no JSON behind it: drop the tag, keep the rest.
      cursor = open + TOOL_USE_OPEN.length
      continue
    }
    const objectEnd = balancedObjectEnd(text, objectStart)
    if (objectEnd < 0) {
      // Cut off mid-JSON: nothing to call, nothing to show.
      break
    }
    const call = toolCallFromJson(
      text.slice(objectStart, objectEnd + 1),
      `kimi_${requestId}_${toolCalls.length}`,
    )
    if (call) toolCalls.push(call)
    cursor = objectEnd + 1
    const closeAt = text.indexOf(TOOL_USE_CLOSE, cursor)
    if (closeAt >= 0 && text.slice(cursor, closeAt).trim() === '') {
      cursor = closeAt + TOOL_USE_CLOSE.length
    }
  }
  return { outputText: outputText.trim(), toolCalls }
}

/**
 * Native Anthropic-style `tool_use` blocks, should the backend ever answer
 * with them instead of (or beside) the text protocol. Honoured, never
 * requested: the request still carries no `tools`.
 */
export const nativeToolCallsFromContent = (
  content: AnthropicContentBlock[] | undefined,
): ProviderToolCall[] => {
  const toolCalls: ProviderToolCall[] = []
  for (const block of content ?? []) {
    if (block.type !== 'tool_use') continue
    const raw = block as { id?: unknown; input?: unknown; name?: unknown }
    if (typeof raw.name !== 'string' || !raw.name || typeof raw.id !== 'string' || !raw.id) continue
    toolCalls.push({
      arguments: raw.input && typeof raw.input === 'object' && !Array.isArray(raw.input)
        ? raw.input as Record<string, unknown>
        : {},
      toolCallId: raw.id,
      toolName: raw.name,
    })
  }
  return toolCalls
}

export const collectAnthropicStream = async function* (
  response: Response,
): ProviderStreamCapture {
  if (!response.body) {
    throw new Error('Kimi response has no body')
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let outputText = ''
  let reasoningText = ''
  let finishReason: NormalizedFinishReason | undefined
  let usage: InvocationUsage = {}
  // Native tool_use blocks, keyed by content-block index; arguments arrive as
  // input_json_delta fragments and are parsed once the block stops.
  const pendingNativeCalls = new Map<number, { id: string; json: string; name: string }>()
  const toolCalls: ProviderToolCall[] = []

  const cleanupToken = registerStreamReaderCleanup(reader)

  try {
    let ended = false
    while (!ended) {
      const { done, value } = await reader.read()
      if (done) {
        // A stream may end without the blank line that closes its last event;
        // that event is still the model's, so it is read like every other.
        buffer += decoder.decode()
        if (buffer.trim()) buffer += '\n\n'
        ended = true
      } else {
        buffer += decoder.decode(value, { stream: true })
      }
      // Anthropic SSE separates events by blank lines.
      let blankIndex: number
      while ((blankIndex = buffer.indexOf('\n\n')) >= 0) {
        const rawEvent = buffer.slice(0, blankIndex)
        buffer = buffer.slice(blankIndex + 2)

        let dataLine: string | undefined
        for (const line of rawEvent.split('\n')) {
          // SSE allows an optional space after the colon - Anthropic uses
          // "data: " but Kimi emits "data:" without padding.
          if (line.startsWith('data:')) {
            dataLine = line.slice(5).trim()
          }
        }
        if (!dataLine) {
          continue
        }

        let parsed: AnthropicStreamEvent
        try {
          parsed = JSON.parse(dataLine) as AnthropicStreamEvent
        } catch {
          continue
        }

        if (parsed.type === 'message_start') {
          usage = usageFromAnthropic(parsed.message.usage)
          continue
        }
        if (parsed.type === 'content_block_start') {
          const [native] = nativeToolCallsFromContent([parsed.content_block])
          if (native) {
            pendingNativeCalls.set(parsed.index, { id: native.toolCallId, json: '', name: native.toolName })
          }
          continue
        }
        if (parsed.type === 'content_block_delta') {
          if (parsed.delta.type === 'text_delta') {
            outputText += parsed.delta.text
            yield { type: 'output_text.delta', text: parsed.delta.text }
          } else if (parsed.delta.type === 'thinking_delta') {
            reasoningText += parsed.delta.thinking
            yield { type: 'reasoning_text.delta', text: parsed.delta.thinking }
          } else if (parsed.delta.type === 'input_json_delta') {
            const pending = pendingNativeCalls.get(parsed.index)
            if (pending) pending.json += parsed.delta.partial_json
          }
          continue
        }
        if (parsed.type === 'content_block_stop') {
          const pending = pendingNativeCalls.get(parsed.index)
          if (pending) {
            pendingNativeCalls.delete(parsed.index)
            let args: Record<string, unknown> = {}
            try {
              const parsedArgs = pending.json.trim() ? JSON.parse(pending.json) as unknown : {}
              if (parsedArgs && typeof parsedArgs === 'object' && !Array.isArray(parsedArgs)) {
                args = parsedArgs as Record<string, unknown>
              }
            } catch {
              // Unparseable native arguments: an empty call is still a call the
              // loop can refuse or retry; silent loss is the failure to avoid.
            }
            toolCalls.push({ arguments: args, toolCallId: pending.id, toolName: pending.name })
          }
          continue
        }
        if (parsed.type === 'message_delta') {
          if (parsed.delta.stop_reason) {
            finishReason = normalizeAnthropicFinishReason(parsed.delta.stop_reason)
          }
          if (parsed.usage) {
            const next = usageFromAnthropic(parsed.usage)
            usage = {
              inputTokens: next.inputTokens ?? usage.inputTokens,
              outputTokens: next.outputTokens ?? usage.outputTokens,
              totalTokens: next.totalTokens ?? usage.totalTokens,
            }
          }
          continue
        }
        if (parsed.type === 'error') {
          throw new Error(parsed.error?.message ?? 'Kimi stream error')
        }
      }
    }
  } finally {
    await releaseStreamReader(reader, cleanupToken)
  }

  return {
    finishReason,
    outputText,
    reasoningText,
    toolCalls,
    usage,
  }
}
