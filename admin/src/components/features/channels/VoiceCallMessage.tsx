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

  return (
    <div className="grid gap-2">
      <span className="text-sm font-medium" style={{ color: 'var(--tx)' }}>
        {header}
      </span>

      {shown.length > 0 ? (
        <div className="grid gap-1">
          {shown.map((line, index) => (
            <span className="text-sm" key={`${index}-${line.slice(0, 24)}`} style={{ color: 'var(--tx2)' }}>
              {line}
            </span>
          ))}
        </div>
      ) : null}

      {hidden > 0 ? (
        <button
          className="justify-self-start text-sm"
          onClick={() => setExpanded(!expanded)}
          style={{ color: 'var(--accent)' }}
          type="button"
        >
          {expanded ? 'Show less' : `Show all ${body.length} turns`}
        </button>
      ) : null}
    </div>
  )
}
