import type { ProviderMessage } from '@nessie/runtime'
import {
  isProtectedMailOperationalTool,
  protectedMailUtilityTranscriptSummary,
} from './tool-util.js'

/**
 * Utility models are not authorized correspondence readers. Once a run has
 * used protected mail, an assistant can still describe that correspondence in
 * a later ordinary-looking turn. Keep that prose in the main inference only;
 * utility transcripts receive this stable server-authored marker instead.
 */
export const PROTECTED_MAIL_ASSISTANT_CONTENT_MARKER =
  '[Assistant content withheld after protected email context.]'

// Utility-model calls are intentionally outside the main agent's authorized
// correspondence context. Compaction and checkpoint writers need the shape of
// a mail action, but never its recipients, subject, body, address, or provider
// response. These summaries are server-authored and contain no tool output.
/**
 * A protected tool call itself is context-sensitive: its arguments may name
 * recipients or an account even before a result is appended. Treat it as a
 * boundary so callers can fail closed while model-visible reasoning streams.
 */
export const hasProtectedMailContext = (messages: readonly ProviderMessage[]): boolean =>
  messages.some((message) =>
    message.role === 'assistant'
    && (message.toolCalls ?? []).some((toolCall) => isProtectedMailOperationalTool(toolCall.toolName)),
  )

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
  let protectedContextSeen = false

  return messages.map((message) => {
    if (message.role === 'assistant') {
      const containsProtectedMailCall = (message.toolCalls ?? [])
        .some((toolCall) => isProtectedMailOperationalTool(toolCall.toolName))
      for (const toolCall of message.toolCalls ?? []) {
        toolNameByCallId.set(toolCall.toolCallId, toolCall.toolName)
      }
      protectedContextSeen ||= containsProtectedMailCall
      return protectedContextSeen
        ? { ...message, content: PROTECTED_MAIL_ASSISTANT_CONTENT_MARKER }
        : message
    }
    if (message.role !== 'tool') return message

    const toolName = toolNameByCallId.get(message.toolCallId)
    const summary = toolName ? protectedMailUtilityTranscriptSummary(toolName) : null
    return summary ? { ...message, content: summary } : message
  })
}
