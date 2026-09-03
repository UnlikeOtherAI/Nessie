import { useState } from 'react'
import { MessageMarkdown } from './MessageMarkdown'
import { VoiceTranscriptDialog } from './VoiceTranscriptDialog'

/**
 * A finished voice call, in the feed.
 *
 * The call leaves two artefacts and this card shows both. The message content
 * is a **compaction** — what was discussed and decided, in the assistant's own
 * voice, with the filler dropped — and it renders as the card's body because it
 * is also what the assistant carries into every later run. The verbatim
 * transcript is an attachment, and "Full transcript" opens it in place.
 *
 * `compacted` says which shape the content is, from the server's own metadata
 * rather than by reading the text: compaction fails open, and a fallback record
 * is a list of spoken turns that would read as one run-on paragraph through a
 * markdown renderer. Those turns keep the fold they always had.
 */

/** Turns shown before the fold. Enough to recall the call without dominating. */
const COLLAPSED_TURNS = 10

/**
 * Longest thing treated as a speaker label.
 *
 * Each turn is written `Speaker: what they said`, but spoken text contains
 * colons of its own — a time, a ratio, a quoted phrase. Requiring the prefix
 * to be short keeps "It is 3:15" from rendering "It is 3" as a speaker.
 */
const MAX_SPEAKER_CHARS = 40

/** Splits a turn into who spoke and what they said, when it reads as one. */
const splitTurn = (line: string): { speaker: string; text: string } | null => {
  const at = line.indexOf(': ')
  if (at <= 0 || at > MAX_SPEAKER_CHARS) return null
  return { speaker: line.slice(0, at), text: line.slice(at + 2) }
}

/** The fallback record: spoken turns, folded. */
const SpokenTurns = ({ body }: { body: string[] }) => {
  const [expanded, setExpanded] = useState(false)
  const hidden = Math.max(0, body.length - COLLAPSED_TURNS)
  const shown = expanded ? body : body.slice(0, COLLAPSED_TURNS)
  // Count only lines that read as a spoken turn: the body also carries the
  // server's closing note about the attachment, and counting it made the
  // control disagree with the summary above it (14 turns, "show all 15").
  const turnCount = body.filter((line) => splitTurn(line) !== null).length

  return (
    <>
      {shown.length > 0 ? (
        <div className="grid gap-1">
          {shown.map((line, index) => {
            const turn = splitTurn(line)
            return (
              <span
                className="text-sm"
                key={`${index}-${line.slice(0, 24)}`}
                style={{ color: 'var(--tx2)' }}
              >
                {turn ? (
                  <>
                    {/* Who spoke carries the scanning weight: a person reading
                        back a call is looking for the turns, not the prose. */}
                    <strong style={{ color: 'var(--tx)' }}>{turn.speaker}:</strong>{' '}
                    {turn.text}
                  </>
                ) : (
                  line
                )}
              </span>
            )
          })}
        </div>
      ) : null}

      {hidden > 0 ? (
        <button
          className="justify-self-start text-sm"
          onClick={() => setExpanded(!expanded)}
          style={{ color: 'var(--accent)' }}
          type="button"
        >
          {expanded ? 'Show less' : `Show all ${turnCount} turns`}
        </button>
      ) : null}
    </>
  )
}

export type VoiceCallRecord = {
  compacted: boolean
  transcriptAttachmentId: string | null
}

/**
 * Reads the server-written `metadata.voiceCall`, or null when the message is
 * not a call record.
 *
 * Structural, never a reading of the text: the API writes this key itself when
 * it records a hang-up. Records written before compaction shipped carry no
 * `compacted` flag and read as the fallback shape, which is exactly what they
 * are.
 */
export const readVoiceCallRecord = (metadata: unknown): VoiceCallRecord | null => {
  const voiceCall = (metadata as { voiceCall?: unknown } | undefined)?.voiceCall
  if (!voiceCall || typeof voiceCall !== 'object') return null
  const record = voiceCall as { compacted?: unknown; transcriptAttachmentId?: unknown }
  return {
    compacted: record.compacted === true,
    transcriptAttachmentId:
      typeof record.transcriptAttachmentId === 'string' ? record.transcriptAttachmentId : null,
  }
}

export type VoiceCallMessageProps = {
  /** True when the body is a generated compaction rather than raw turns. */
  compacted: boolean
  /** The message content: the summary line, then the body. */
  content: string
  /** Null for a call too short to store one; then there is nothing to open. */
  transcriptAttachmentId: string | null
}

export const VoiceCallMessage = ({
  compacted,
  content,
  transcriptAttachmentId,
}: VoiceCallMessageProps) => {
  const [transcriptOpen, setTranscriptOpen] = useState(false)

  const lines = content.split('\n')
  // The first non-empty line is the summary the server wrote
  // ("Voice call · 1 min · 8 turns"); everything after it is the body.
  const headerIndex = lines.findIndex((line) => line.trim().length > 0)
  const header = headerIndex >= 0 ? (lines[headerIndex] ?? '') : ''
  const body = lines.slice(headerIndex + 1)

  return (
    <div className="grid gap-2">
      <span className="text-sm font-medium" style={{ color: 'var(--tx)' }}>
        {header}
      </span>

      {compacted ? (
        <div className="text-sm" style={{ color: 'var(--tx2)' }}>
          <MessageMarkdown allowRemoteImages={false} renderInlineText={(inline) => inline}>
            {body.join('\n').trim()}
          </MessageMarkdown>
        </div>
      ) : (
        <SpokenTurns body={body.filter((line) => line.trim().length > 0)} />
      )}

      {transcriptAttachmentId ? (
        <>
          <button
            className="justify-self-start text-sm"
            onClick={() => setTranscriptOpen(true)}
            style={{ color: 'var(--accent)' }}
            type="button"
          >
            Full transcript
          </button>
          <VoiceTranscriptDialog
            attachmentId={transcriptAttachmentId}
            onClose={() => setTranscriptOpen(false)}
            open={transcriptOpen}
          />
        </>
      ) : null}
    </div>
  )
}
