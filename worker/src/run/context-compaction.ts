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
import { estimateShownToolImageTokens } from './context-management.js'
import { deriveProviderInputComponent } from './execute/provenanced-provider-input.js'
import { isToolImagesMessage } from './tool-images.js'

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
  messages.map((message) => {
    if (!(message.role === 'system' && message.content.startsWith(COMPACTION_NOTE_MARKER))) {
      return message
    }
    const normalized = buildCompactedMessages(
        { elder: [], previousNote: null, system: [], tail: [] },
        message.content.slice(COMPACTION_NOTE_MARKER.length).trim(),
      )[0]!
    return deriveProviderInputComponent(message, normalized, 'compaction')
  })

// A tool-images turn belongs right after the tool results it carries the
// pictures of; anywhere else it names calls the transcript no longer holds.
const withoutOrphanedToolImages = (messages: ProviderMessage[]): ProviderMessage[] =>
  messages.filter((message, index) => !isToolImagesMessage(message) || messages[index - 1]?.role === 'tool')

/**
 * Nessie owns the utility invocation, its metering, the crash checkpoint and
 * all run disclosure state. The shared helper is deliberately only the pure
 * transcript-to-transcript transformation.
 *
 * That helper groups and prices the transcript by `@deep/agent`'s own rules,
 * which know nothing of a tool-images turn (`tool-images.ts`): it prices none
 * of its pictures, and it can keep the turn in the tail while folding the
 * batch it answers into the note. So the target it is handed leaves room for
 * the pictures still shown, and a tool-images turn the rebuilt transcript no
 * longer places right after its tool results is dropped — the note carries
 * what those calls found. The emergency trim uses Nessie's own grouping
 * (`context-management.ts`), which keeps the turn with its batch.
 */
export const runContextCompaction = async (input: {
  generateNote: (prompt: string) => Promise<string | null>
  messages: ProviderMessage[]
  targetTokens: number
}): Promise<ProviderMessage[] | null> => {
  const messages = normalizeLegacyCompactionNotes(input.messages)
  const compacted = await runSharedContextCompaction({
    ...input,
    messages,
    targetTokens: Math.max(0, input.targetTokens - estimateShownToolImageTokens(messages)),
  })
  return compacted && withoutOrphanedToolImages(compacted)
}
