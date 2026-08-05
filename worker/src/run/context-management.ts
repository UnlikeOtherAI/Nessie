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

// Closed units of context: an assistant turn that requested tool calls stays
// glued to its tool results. Every context operation (trim, compaction) works
// on groups so a tool result can never be orphaned from its call.
export const groupMessages = (messages: ProviderMessage[]): ProviderMessage[][] => {
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

// Emergency fallback ONLY: silent truncation of the oldest groups. Real
// context lifecycle is compaction (context-compaction.ts); this runs when a
// compaction call itself fails, or on a provider-overflow retry after
// compaction has already been attempted.
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
