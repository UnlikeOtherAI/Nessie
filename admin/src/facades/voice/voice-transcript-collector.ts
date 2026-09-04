import { redactDetectedSecrets, type VoiceTranscriptLine } from '@nessie/schemas'

/**
 * Assembles the call transcript from streamed fragments.
 *
 * Gemini sends transcription in pieces — often a word or two at a time, for
 * both speakers, interleaved. A line is only finalised at a turn boundary,
 * because that is the point at which the sentence is actually complete; until
 * then the partial text drives the live ticker instead.
 */

export type TranscriptCollector = {
  appendUser: (fragment: string) => void
  appendAssistant: (fragment: string) => void
  /** Closes whatever is open, stamping it at `atMs` since the call began. */
  finalise: (nowMs: number) => void
  liveUserText: () => string
  liveAssistantText: () => string
  lines: () => VoiceTranscriptLine[]
}

/** Guard against one runaway turn: a line past this is closed where it stands. */
const MAX_LINE_CHARS = 4_000

export const collectTranscript = (startedAtMs = Date.now()): TranscriptCollector => {
  const finalised: VoiceTranscriptLine[] = []
  let userBuffer = ''
  let assistantBuffer = ''
  // When the current turn began, so a finalised line is stamped at its start
  // rather than at the moment it happened to end.
  let userStartedAt: number | null = null
  let assistantStartedAt: number | null = null

  const push = (speaker: 'user' | 'assistant', text: string, startedAt: number | null): void => {
    const trimmed = redactDetectedSecrets(text).trim()
    if (trimmed.length === 0) return
    finalised.push({
      speaker,
      text: trimmed.slice(0, MAX_LINE_CHARS),
      atMs: Math.max(0, (startedAt ?? Date.now()) - startedAtMs),
    })
  }

  return {
    appendUser: (fragment) => {
      if (userStartedAt === null) userStartedAt = Date.now()
      userBuffer += fragment
    },
    appendAssistant: (fragment) => {
      if (assistantStartedAt === null) assistantStartedAt = Date.now()
      assistantBuffer += fragment
    },
    finalise: () => {
      // The person's line lands first: within one turn they spoke before the
      // assistant answered, and the record should read in that order.
      push('user', userBuffer, userStartedAt)
      push('assistant', assistantBuffer, assistantStartedAt)
      userBuffer = ''
      assistantBuffer = ''
      userStartedAt = null
      assistantStartedAt = null
    },
    liveUserText: () => redactDetectedSecrets(userBuffer).trim(),
    liveAssistantText: () => redactDetectedSecrets(assistantBuffer).trim(),
    lines: () => [...finalised],
  }
}
