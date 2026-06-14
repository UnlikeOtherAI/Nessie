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

const KIMI_TOOL_PREAMBLE = `You can invoke tools by emitting blocks of the form:
<tool_use>{"name":"<tool_name>","arguments":{...}}</tool_use>
Rules:
- Emit the entire JSON on a single block — name and arguments are required.
- You may emit multiple <tool_use> blocks; each will be dispatched and the results returned to you.
- Wait for tool results before drawing final conclusions; do not invent results.
- If no tool is needed, answer in plain text.`

const renderKimiTools = (
  tools: ToolSchemaDescriptor[] | undefined,
): string | undefined => {
  if (!tools || tools.length === 0) {
    return undefined
  }
  const lines = tools.map((tool) => {
    const schema = JSON.stringify(tool.inputSchema)
    return `- ${tool.toolName}: ${tool.description}\n  input_schema: ${schema}`
  })
  return `${KIMI_TOOL_PREAMBLE}\n\nAvailable tools:\n${lines.join('\n')}`
}

const renderAssistantWithToolCalls = (
  content: string | null,
  toolCalls: ProviderToolCall[] | undefined,
): string => {
  const parts: string[] = []
  if (content && content.trim()) {
    parts.push(content)
  }
  for (const call of toolCalls ?? []) {
    parts.push(
      `<tool_use>${JSON.stringify({ name: call.toolName, arguments: call.arguments })}</tool_use>`,
    )
  }
  return parts.join('\n')
}

// A system block is either a plain string or Anthropic's content-block array
// form, which lets us attach a cache_control breakpoint for prompt caching.
type AnthropicSystem =
  | string
  | Array<{ type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }>

// Anthropic puts the system prompt at the top level and forbids it as a
// message role. Squash any system entries into a single string, then map the
// rest. Tool/result messages are folded into text turns so the prompt-
// translated tool layer can flow through unchanged.
//
// When `cache` is set, the system (the agent's prompt + the rendered tool block
// — the large, byte-stable prefix) is emitted as a content-block array with a
// cache_control breakpoint, so repeated turns/runs read it from the prompt cache
// at a steep discount. Verified accepted + honored by Kimi's Anthropic endpoint.
export const toAnthropicPayload = (
  messages: ProviderMessage[],
  tools?: ToolSchemaDescriptor[],
  opts?: { cache?: boolean },
): { system?: AnthropicSystem; messages: Array<{ role: 'user' | 'assistant'; content: string }> } => {
  const systemParts: string[] = []
  const toolBlock = renderKimiTools(tools)
  if (toolBlock) {
    systemParts.push(toolBlock)
  }
  const out: Array<{ role: 'user' | 'assistant'; content: string }> = []

  for (const message of messages) {
    if (message.role === 'system') {
      systemParts.push(message.content)
      continue
    }
    const role: 'user' | 'assistant' = message.role === 'assistant' ? 'assistant' : 'user'
    let content: string
    if (message.role === 'tool') {
      content = `<tool_result tool_call_id="${message.toolCallId}">\n${message.content}\n</tool_result>`
    } else if (message.role === 'assistant') {
      content = renderAssistantWithToolCalls(message.content, message.toolCalls)
    } else {
      content = message.content
    }
    if (!content) {
      continue
    }
    const last = out.at(-1)
    if (last && last.role === role) {
      // Anthropic rejects consecutive same-role turns; concatenate them.
      last.content += `\n\n${content}`
      continue
    }
    out.push({ role, content })
  }

  // Anthropic also requires the first message to be `user`.
  const first = out[0]
  if (first && first.role !== 'user') {
    out.unshift({ role: 'user', content: '(continue)' })
  }

  const systemText = systemParts.length > 0 ? systemParts.join('\n\n') : undefined
  const system: AnthropicSystem | undefined =
    systemText !== undefined && opts?.cache
      ? [{ type: 'text', text: systemText, cache_control: { type: 'ephemeral' } }]
      : systemText

  return {
    system,
    messages: out,
  }
}

const KIMI_TOOL_USE_RE = /<tool_use>\s*(\{[\s\S]*?\})\s*<\/tool_use>/g

export const parseKimiToolCalls = (
  text: string,
  requestId: string,
): { outputText: string; toolCalls: ProviderToolCall[] } => {
  const toolCalls: ProviderToolCall[] = []
  for (const match of text.matchAll(KIMI_TOOL_USE_RE)) {
    const jsonPart = match[1]
    if (!jsonPart) {
      continue
    }
    try {
      const parsed = JSON.parse(jsonPart) as {
        name?: string
        arguments?: Record<string, unknown>
      }
      if (parsed.name && typeof parsed.name === 'string') {
        toolCalls.push({
          arguments: parsed.arguments && typeof parsed.arguments === 'object'
            ? parsed.arguments
            : {},
          toolCallId: `kimi_${requestId}_${toolCalls.length}`,
          toolName: parsed.name,
        })
      }
    } catch {
      // Drop malformed tool_use blocks; the model can retry.
    }
  }
  const outputText = text.replace(KIMI_TOOL_USE_RE, '').trim()
  return { outputText, toolCalls }
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
  let finishReason: NormalizedFinishReason | undefined
  let usage: InvocationUsage = {}

  const cleanupToken = registerStreamReaderCleanup(reader)

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }

      buffer += decoder.decode(value, { stream: true })
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
        if (parsed.type === 'content_block_delta') {
          if (parsed.delta.type === 'text_delta') {
            outputText += parsed.delta.text
            yield { type: 'output_text.delta', text: parsed.delta.text }
          } else if (parsed.delta.type === 'thinking_delta') {
            yield { type: 'reasoning_text.delta', text: parsed.delta.thinking }
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
    toolCalls: [],
    usage,
  }
}
