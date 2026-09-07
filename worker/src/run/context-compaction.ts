import {
  buildCompactionPrompt,
  buildCompactedMessages,
  COMPACTION_NOTE_FENCE_TAG,
  COMPACTION_NOTE_MARKER,
  collectSourceUrls,
  compactContext,
  runContextCompaction as runSharedContextCompaction,
  selectCompactionSlice,
  type CompactionSlice,
} from '@deep/agent'
import type { ProviderMessage } from '@nessie/runtime'

export {
  buildCompactionPrompt,
  buildCompactedMessages,
  COMPACTION_NOTE_FENCE_TAG,
  COMPACTION_NOTE_MARKER,
  collectSourceUrls,
  compactContext,
  selectCompactionSlice,
}
export type { CompactionSlice }

export const normalizeLegacyCompactionNotes = (messages: ProviderMessage[]): ProviderMessage[] =>
  messages.map((message) =>
    message.role === 'system' && message.content.startsWith(COMPACTION_NOTE_MARKER)
      ? buildCompactedMessages(
        { elder: [], previousNote: null, system: [], tail: [] },
        message.content.slice(COMPACTION_NOTE_MARKER.length).trim(),
      )[0]!
      : message,
  )

/**
 * Nessie owns the utility invocation, its metering, the crash checkpoint and
 * all run disclosure state. The shared helper is deliberately only the pure
 * transcript-to-transcript transformation.
 */
export const runContextCompaction = async (input: {
  generateNote: (prompt: string) => Promise<string | null>
  messages: ProviderMessage[]
  targetTokens: number
}): Promise<ProviderMessage[] | null> => runSharedContextCompaction({
  ...input,
  messages: normalizeLegacyCompactionNotes(input.messages),
})
