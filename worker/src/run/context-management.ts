import type { ProviderMessage, ToolSchemaDescriptor } from '@nessie/runtime'

import { isToolImagesMessage, TOOL_IMAGE_TURNS_SHOWN } from './tool-images.js'

export const estimateTokens = (text: string): number =>
  Math.ceil(text.length / 4)

export const estimateToolSchemaTokens = (tools: ToolSchemaDescriptor[]): number =>
  tools.reduce((sum, tool) => {
    const schemaText = `${tool.toolName}: ${tool.description} ${JSON.stringify(tool.inputSchema)}`
    return sum + estimateTokens(schemaText)
  }, 0)

// An inlined image is billed as image tokens the character heuristic cannot
// see. One flat, deliberately generous figure per image (a 640-1024px picture
// lands well under this on every provider) keeps the window math honest, so a
// thread full of photos triggers compaction instead of overflowing the model.
const IMAGE_TOKEN_ESTIMATE = 1500

// A tool's image is a full-page screenshot, not a chat photo: a 1918×957
// Kelpie capture measured about 2 300 prompt tokens on the production model
// (docs/plans/2026-09-22-executor-local-apps/screenshots.md). Priced as a
// photo, two shown screenshot turns ran a third over their estimate, and
// compaction fired after the window had already overflowed.
const TOOL_IMAGE_TOKEN_ESTIMATE = 2_300

// A tool-images turn holds references, and its pictures are read in when the
// provider input is built (`tool-images.ts`), so they are counted from the
// references — unless the turn is one too old to carry them any more.
export const estimateMessageTokens = (msg: ProviderMessage, toolImagesShown = true): number => {
  let content = ''
  let imageTokens = 0
  if (msg.role === 'assistant') {
    content = msg.content ?? ''
    if (msg.toolCalls) {
      content += msg.toolCalls.map((tc) => JSON.stringify(tc)).join('')
    }
  } else {
    content = msg.content
    if (msg.role === 'user' && msg.images) {
      imageTokens = msg.images.length * IMAGE_TOKEN_ESTIMATE
    } else if (isToolImagesMessage(msg) && toolImagesShown) {
      imageTokens = msg.toolImages.length * TOOL_IMAGE_TOKEN_ESTIMATE
    }
  }
  return estimateTokens(content) + imageTokens + 4
}

const shownToolImageTurns = (messages: ProviderMessage[]): Set<ProviderMessage> => new Set(
  messages.filter((msg) => isToolImagesMessage(msg)).slice(-TOOL_IMAGE_TURNS_SHOWN),
)

export const estimateMessagesTokens = (messages: ProviderMessage[]): number => {
  const shown = shownToolImageTurns(messages)
  return messages.reduce((sum, msg) => sum + estimateMessageTokens(msg, shown.has(msg)), 0)
}

/**
 * The tokens the pictures of the shown tool-images turns add: what an
 * estimator that knows only `images` — `@deep/agent`'s — leaves out.
 */
export const estimateShownToolImageTokens = (messages: ProviderMessage[]): number =>
  [...shownToolImageTurns(messages)].reduce(
    (sum, msg) => sum + (isToolImagesMessage(msg) ? msg.toolImages.length * TOOL_IMAGE_TOKEN_ESTIMATE : 0),
    0,
  )

// Closed units of context: an assistant turn that requested tool calls stays
// glued to its tool results, and to the turn carrying their images. Every
// context operation (trim, compaction) works on groups so a tool result can
// never be orphaned from its call.
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
      if (j > i + 1 && j < messages.length && isToolImagesMessage(messages[j]!)) {
        group.push(messages[j]!)
        j++
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
