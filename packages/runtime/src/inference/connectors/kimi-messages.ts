import type { ProviderMessage, ProviderToolCall, ToolSchemaDescriptor } from '../types.js'

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

// A text block in Anthropic's content-block array form, which lets us attach a
// cache_control breakpoint for prompt caching.
type AnthropicTextBlock = {
  type: 'text'
  text: string
  cache_control?: { type: 'ephemeral' }
}
type AnthropicSystem = string | AnthropicTextBlock[]
export type AnthropicPayloadMessage = {
  role: 'user' | 'assistant'
  content: string | AnthropicTextBlock[]
}

// Anthropic puts the system prompt at the top level and forbids it as a
// message role. Hoist the leading system entries there, then map the rest. Tool/result
// messages are folded into text turns so the prompt-translated tool layer can
// flow through unchanged.
//
// When `cache` is set, the system is emitted as a content-block array whose
// cache_control breakpoint sits on the stable block ONLY — the rendered tool
// block plus the FIRST system message (the agent's byte-stable anchor). Every
// later leading system message (memory context, checkpoint notes) is volatile
// and lands in uncached follow-on blocks, so it can
// vary without busting the cached prefix. A second, sliding breakpoint goes on
// the last message: each loop iteration only appends turns, so the previous
// tail breakpoint still names a valid prefix and a multi-iteration run
// cache-reads its whole transcript (Anthropic's protocol allows 4 breakpoints).
// Verified accepted + honored by Kimi's Anthropic endpoint.
export const toAnthropicPayload = (
  messages: ProviderMessage[],
  tools?: ToolSchemaDescriptor[],
  opts?: { cache?: boolean },
): { system?: AnthropicSystem; messages: AnthropicPayloadMessage[] } => {
  const stableParts: string[] = []
  const volatileParts: string[] = []
  const toolBlock = renderKimiTools(tools)
  if (toolBlock) {
    stableParts.push(toolBlock)
  }
  let sawSystemAnchor = false
  const out: Array<{ role: 'user' | 'assistant'; content: string }> = []

  for (const message of messages) {
    if (message.role === 'system' && out.length === 0) {
      if (sawSystemAnchor) {
        volatileParts.push(message.content)
      } else {
        stableParts.push(message.content)
        sawSystemAnchor = true
      }
      continue
    }
    const role: 'user' | 'assistant' = message.role === 'assistant' ? 'assistant' : 'user'
    let content: string
    if (message.role === 'tool') {
      content = `<tool_result tool_call_id="${message.toolCallId}">\n${message.content}\n</tool_result>`
    } else if (message.role === 'assistant') {
      content = renderAssistantWithToolCalls(message.content, message.toolCalls)
    } else if (message.role === 'system') {
      // Hoisting a continuation leaves the prior assistant answer last, which
      // Messages treats as a prefill and Kimi ends with an empty response.
      content = `<system_instruction>\n${message.content}\n</system_instruction>`
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

  if (!opts?.cache) {
    const allParts = [...stableParts, ...volatileParts]
    return {
      system: allParts.length > 0 ? allParts.join('\n\n') : undefined,
      messages: out,
    }
  }

  const system: AnthropicTextBlock[] = []
  if (stableParts.length > 0) {
    system.push({
      cache_control: { type: 'ephemeral' },
      text: stableParts.join('\n\n'),
      type: 'text',
    })
  }
  for (const part of volatileParts) {
    system.push({ text: part, type: 'text' })
  }

  const lastIndex = out.length - 1
  return {
    system: system.length > 0 ? system : undefined,
    messages: out.map((message, index): AnthropicPayloadMessage =>
      index === lastIndex
        ? {
            content: [{
              cache_control: { type: 'ephemeral' },
              text: message.content,
              type: 'text',
            }],
            role: message.role,
          }
        : message,
    ),
  }
}

