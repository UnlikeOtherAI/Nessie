import { useState } from 'react'

/**
 * A finished voice call, in the feed.
 *
 * The record is one message holding the whole spoken exchange, which printed
 * in full buries the conversation it belongs to — a two-minute call is a wall
 * of text between two ordinary messages. So it collapses: the summary line,
 * the opening turns, and a control to see the rest in place.
 *
 * It renders the message's own content rather than re-deriving anything, so
 * what a person reads here, what search indexes, and what the assistant sees
 * in its context window are the same words.
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

export type VoiceCallMessageProps = {
  /** The message content: a summary line, then one line per spoken turn. */
  content: string
}

export const VoiceCallMessage = ({ content }: VoiceCallMessageProps) => {
  const [expanded, setExpanded] = useState(false)

  const lines = content.split('\n')
  // The first non-empty line is the summary the server wrote
  // ("Voice call · 1 min · 8 turns"); everything after it is the exchange.
  const headerIndex = lines.findIndex((line) => line.trim().length > 0)
  const header = headerIndex >= 0 ? (lines[headerIndex] ?? '') : ''
  const body = lines.slice(headerIndex + 1).filter((line) => line.trim().length > 0)

  const hidden = Math.max(0, body.length - COLLAPSED_TURNS)
  const shown = expanded ? body : body.slice(0, COLLAPSED_TURNS)
  // Count only lines that read as a spoken turn: the body also carries the
  // server's closing note about the attachment, and counting it made the
  // control disagree with the summary above it (14 turns, "show all 15").
  const turnCount = body.filter((line) => splitTurn(line) !== null).length

  return (
    <div className="grid gap-2">
      <span className="text-sm font-medium" style={{ color: 'var(--tx)' }}>
        {header}
      </span>

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
    </div>
  )
}
