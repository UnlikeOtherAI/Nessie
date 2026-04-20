import type { ProviderMessage, ToolSchemaDescriptor } from '@nessie/runtime'

export const estimateTokens = (text: string): number =>
  Math.ceil(text.length / 4)

export const estimateToolSchemaTokens = (tools: ToolSchemaDescriptor[]): number =>
  tools.reduce((sum, tool) => {
    const schemaText = `${tool.toolName}: ${tool.description} ${JSON.stringify(tool.inputSchema)}`
    return sum + estimateTokens(schemaText)
  }, 0)

export const estimateMessageTokens = (msg: ProviderMessage): number => {
  let content = ''
  if (msg.role === 'assistant') {
    content = msg.content ?? ''
    if (msg.toolCalls) {
      content += msg.toolCalls.map((tc) => JSON.stringify(tc)).join('')
    }
  } else {
    content = msg.content
  }
  return estimateTokens(content) + 4
}

export const estimateMessagesTokens = (messages: ProviderMessage[]): number =>
  messages.reduce((sum, msg) => sum + estimateMessageTokens(msg), 0)

const groupMessages = (messages: ProviderMessage[]): ProviderMessage[][] => {
  const groups: ProviderMessage[][] = []
  let i = 0

  while (i < messages.length) {
    const msg = messages[i]!
    if (msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0) {
      const group: ProviderMessage[] = [msg]
      const toolCallIds = new Set(msg.toolCalls.map((tc) => tc.toolCallId))
      let j = i + 1
      while (j < messages.length && messages[j]!.role === 'tool') {
        const toolMsg = messages[j] as { role: 'tool'; content: string; toolCallId: string }
        if (toolCallIds.has(toolMsg.toolCallId)) {
          group.push(messages[j]!)
          j++
        } else {
          break
        }
      }
      groups.push(group)
      i = j
    } else {
      groups.push([msg])
      i++
    }
  }

  return groups
}

export const trimConversationToFit = (
  messages: ProviderMessage[],
  maxTokens: number,
  toolSchemaTokens: number = 0,
): ProviderMessage[] => {
  const effectiveBudget = maxTokens - toolSchemaTokens
  if (estimateMessagesTokens(messages) <= effectiveBudget) {
    return messages
  }

  const groups = groupMessages(messages)
  const systemGroups = groups.filter((g) => g[0]!.role === 'system')
  const nonSystemGroups = groups.filter((g) => g[0]!.role !== 'system')

  const systemTokens = systemGroups.flat().reduce((sum, msg) => sum + estimateMessageTokens(msg), 0)
  const budget = effectiveBudget - systemTokens

  let usedTokens = 0
  const fromRecent = [...nonSystemGroups].reverse()
  const reversedKept: ProviderMessage[][] = []

  for (const group of fromRecent) {
    const groupTokens = group.reduce((sum, msg) => sum + estimateMessageTokens(msg), 0)
    if (usedTokens + groupTokens > budget) break
    reversedKept.push(group)
    usedTokens += groupTokens
  }

  return [...systemGroups.flat(), ...reversedKept.reverse().flat()]
}

export const buildCompactionPrompt = (
  messagesToCompact: ProviderMessage[],
): string => {
  const transcript = messagesToCompact
    .map((m) => {
      if (m.role === 'tool') return `[tool:${m.toolCallId}]: ${m.content.slice(0, 500)}`
      if (m.role === 'assistant' && m.toolCalls) {
        return `[assistant]: ${m.content ?? ''}\n  [called: ${m.toolCalls.map((tc) => tc.toolName).join(', ')}]`
      }
      return `[${m.role}]: ${typeof m.content === 'string' ? m.content : '(content)'}`
    })
    .join('\n')

  return [
    'Summarize this conversation history into a concise context paragraph.',
    'Preserve: key facts, decisions made, tool results that matter, and the current goal.',
    'Drop: greetings, acknowledgments, redundant information, verbose tool output.',
    'Output only the summary, no preamble.',
    '',
    transcript,
  ].join('\n')
}
