import {
  CONTACTS_SEARCH_TOOL_ID,
  EMAIL_LIST_TOOL_ID,
  EMAIL_READ_TOOL_ID,
  EMAIL_SEND_TOOL_ID,
  GMAIL_ATTACHMENT_READ_TOOL_ID,
  GMAIL_DRAFT_CREATE_TOOL_ID,
  GMAIL_DRAFT_SEND_TOOL_ID,
  GMAIL_DRAFT_UPDATE_TOOL_ID,
  GMAIL_MESSAGE_READ_TOOL_ID,
  GMAIL_SEARCH_TOOL_ID,
  GMAIL_THREAD_READ_TOOL_ID,
  MAILBOX_READ_TOOL_ID,
  MAILBOX_SEARCH_TOOL_ID,
  MAILBOX_SEND_TOOL_ID,
  type ProviderMessage,
} from '@nessie/runtime'

// Utility-model calls are intentionally outside the main agent's authorized
// correspondence context. Compaction and checkpoint writers need the shape of
// a mail action, but never its recipients, subject, body, address, or provider
// response. These summaries are server-authored and contain no tool output.
const HOSTED_MAIL_TOOLS = new Set([
  EMAIL_LIST_TOOL_ID,
  EMAIL_READ_TOOL_ID,
  EMAIL_SEND_TOOL_ID,
])

const CONNECTED_MAIL_TOOLS = new Set([
  MAILBOX_SEARCH_TOOL_ID,
  MAILBOX_READ_TOOL_ID,
  MAILBOX_SEND_TOOL_ID,
])

const GMAIL_CORRESPONDENCE_TOOLS = new Set([
  GMAIL_SEARCH_TOOL_ID,
  GMAIL_THREAD_READ_TOOL_ID,
  GMAIL_MESSAGE_READ_TOOL_ID,
  GMAIL_ATTACHMENT_READ_TOOL_ID,
  GMAIL_DRAFT_CREATE_TOOL_ID,
  GMAIL_DRAFT_UPDATE_TOOL_ID,
  GMAIL_DRAFT_SEND_TOOL_ID,
])

const summaryForMailTool = (toolName: string): string | null => {
  if (HOSTED_MAIL_TOOLS.has(toolName)) {
    return '[Hosted mailbox correspondence withheld from utility transcript.]'
  }
  if (CONNECTED_MAIL_TOOLS.has(toolName)) {
    return '[Connected mailbox correspondence withheld from utility transcript.]'
  }
  if (GMAIL_CORRESPONDENCE_TOOLS.has(toolName)) {
    return '[Google mailbox correspondence withheld from utility transcript.]'
  }
  if (toolName === CONTACTS_SEARCH_TOOL_ID) {
    return '[Email contact result withheld from utility transcript.]'
  }
  return null
}

/**
 * Project a main-run transcript into the bounded utility-model view.
 *
 * Tool results do not name their tool, so the mapping must come from the
 * assistant call that owns each `toolCallId`; inspecting result text would be
 * both unreliable and too late for a content boundary. Non-mail tool results
 * remain byte-for-byte unchanged.
 */
export const projectMailToolResultsForUtilityTranscript = (
  messages: readonly ProviderMessage[],
): ProviderMessage[] => {
  const toolNameByCallId = new Map<string, string>()

  return messages.map((message) => {
    if (message.role === 'assistant') {
      for (const toolCall of message.toolCalls ?? []) {
        toolNameByCallId.set(toolCall.toolCallId, toolCall.toolName)
      }
      return message
    }
    if (message.role !== 'tool') return message

    const toolName = toolNameByCallId.get(message.toolCallId)
    const summary = toolName ? summaryForMailTool(toolName) : null
    return summary ? { ...message, content: summary } : message
  })
}
