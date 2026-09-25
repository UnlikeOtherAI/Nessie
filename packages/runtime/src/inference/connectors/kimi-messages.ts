import type { ProviderMessage, ToolSchemaDescriptor } from '../types.js'

type CacheControl = { cache_control?: { type: 'ephemeral' } }
type AnthropicTextBlock = { type: 'text'; text: string } & CacheControl
type AnthropicBlock = AnthropicTextBlock
  | ({ type: 'thinking'; thinking: string } & CacheControl)
  | ({ type: 'tool_use'; id: string; name: string; input: Record<string, unknown> } & CacheControl)
  | ({ type: 'tool_result'; tool_use_id: string; content: string } & CacheControl)
type AnthropicSystem = string | AnthropicTextBlock[]
export type AnthropicPayloadMessage = {
  role: 'user' | 'assistant'
  content: string | AnthropicBlock[]
}

const blocks = (content: AnthropicPayloadMessage['content']): AnthropicBlock[] =>
  typeof content === 'string' ? [{ type: 'text', text: content }] : content

const messageContent = (message: ProviderMessage): AnthropicPayloadMessage['content'] => {
  if (message.role === 'tool') {
    return [{ type: 'tool_result', tool_use_id: message.toolCallId, content: message.content }]
  }
  if (message.role === 'system') return `<system_instruction>\n${message.content}\n</system_instruction>`
  if (message.role !== 'assistant') return message.content
  const content: AnthropicBlock[] = []
  // Kimi accepts its reasoning text without a signature on replay. Keep it
  // before the native call, using the same checkpointed field as DeepSeek.
  if (message.reasoning) content.push({ type: 'thinking', thinking: message.reasoning })
  if (message.content) content.push({ type: 'text', text: message.content })
  for (const call of message.toolCalls ?? []) {
    content.push({ type: 'tool_use', id: call.toolCallId, name: call.toolName, input: call.arguments })
  }
  return content.length === 1 && content[0]?.type === 'text' ? content[0].text : content
}

// Only leading system entries belong in the top-level system prompt. Later
// application instructions stay after the answer they are correcting.
// Native calls/results retain their IDs and block ordering across tool rounds.
export const toAnthropicPayload = (
  messages: ProviderMessage[],
  tools?: ToolSchemaDescriptor[],
  opts?: { cache?: boolean },
): {
  system?: AnthropicSystem
  messages: AnthropicPayloadMessage[]
  tools?: Array<{ name: string; description: string; input_schema: Record<string, unknown> }>
} => {
  const systemParts: string[] = []
  const out: AnthropicPayloadMessage[] = []
  for (const message of messages) {
    if (message.role === 'system' && out.length === 0) {
      systemParts.push(message.content)
      continue
    }
    const role = message.role === 'assistant' ? 'assistant' : 'user'
    const content = messageContent(message)
    if (content.length === 0) continue
    const last = out.at(-1)
    if (last?.role === role) {
      last.content = typeof last.content === 'string' && typeof content === 'string'
        ? `${last.content}\n\n${content}` : [...blocks(last.content), ...blocks(content)]
    } else {
      out.push({ role, content })
    }
  }
  if (out[0] && out[0].role !== 'user') out.unshift({ role: 'user', content: '(continue)' })

  let system: AnthropicSystem | undefined = systemParts.length ? systemParts.join('\n\n') : undefined
  if (opts?.cache) {
    // Cache only the stable first system block; later context is volatile.
    system = systemParts.length ? systemParts.map((text, index) => ({
      type: 'text', text, ...(index === 0 ? { cache_control: { type: 'ephemeral' as const } } : {}),
    })) : undefined
    const tail = out.at(-1)
    if (tail) {
      tail.content = blocks(tail.content)
      const last = tail.content.at(-1)
      if (last && last.type !== 'thinking') last.cache_control = { type: 'ephemeral' }
    }
  }
  return {
    system, messages: out,
    ...(tools?.length ? { tools: tools.map((tool) => ({
      name: tool.toolName, description: tool.description, input_schema: tool.inputSchema,
    })) } : {}),
  }
}
