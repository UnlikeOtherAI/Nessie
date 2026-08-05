import type { KeyboardEvent, MouseEvent } from 'react'
import type { AgentRecord } from '../../../lib/api-client'
import {
  toThinkingLines,
  type PendingStreamMessage,
} from '../../../facades/threads/thinking'
import { AgentAvatar } from '../../shared/AgentAvatar'

// The ticker is lossy: only this many trailing lines stay in the DOM, and the
// viewport clips whatever no longer fits. The full record lives in the dialog.
const TICKER_MAX_LINES = 6

type ThinkingBubbleProps = {
  agent: AgentRecord | null
  agentName: string
  entry: PendingStreamMessage
  onOpen: (runId: string) => void
  token: string | null
  // `full` sits where the reply will land (bottom of the channel or of the
  // reply list); `compact` is the one-line marker under a thread's root row.
  variant: 'compact' | 'full'
}

const containerClass = (variant: ThinkingBubbleProps['variant']): string =>
  [
    'my-1 cursor-pointer rounded-xl border border-dashed border-[color:var(--sep)]',
    'bg-[var(--overlay-weak)] transition-colors hover:bg-[color:var(--main-hover)]',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]',
    // Compact sits under a root row, indented to the message text; full spans
    // the feed like a message row does.
    variant === 'compact'
      ? 'ml-16 mr-5 flex items-center gap-2 px-2.5 py-1'
      : 'mx-5 px-3 py-2',
  ].join(' ')

// "A reply is coming": a dashed, full-width bubble — never a message row — that
// shows the tail of an agent's live thought process while its run is in flight.
export const ThinkingBubble = ({
  agent,
  agentName,
  entry,
  onOpen,
  token,
  variant,
}: ThinkingBubbleProps) => {
  const compact = variant === 'compact'
  const lines = toThinkingLines(entry.thinking, TICKER_MAX_LINES)
  const open = (event: KeyboardEvent<HTMLDivElement> | MouseEvent<HTMLDivElement>) => {
    // The feed's rows toggle their hover actions on click; the bubble is its
    // own affordance and must not trigger them.
    event.stopPropagation()
    onOpen(entry.runId)
  }

  const ticker = (
    <div
      className={[
        'thinking-ticker min-w-0 text-xs leading-4 text-[color:var(--tx3)]',
        compact ? 'h-4 flex-1' : 'mt-1 h-8',
      ].join(' ')}
    >
      {lines.length === 0 ? (
        <div className="italic opacity-80">Thinking…</div>
      ) : (
        lines.map((line) => (
          <div className="whitespace-pre-wrap break-words" key={line.key}>
            {line.kind === 'tool' ? (
              <span aria-hidden="true" className="mr-1 opacity-70">
                ⚙
              </span>
            ) : null}
            {line.text}
          </div>
        ))
      )}
    </div>
  )

  return (
    <div
      aria-label={`View ${agentName}’s thought process`}
      className={containerClass(variant)}
      data-testid="thinking-bubble"
      data-variant={variant}
      onClick={open}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          open(event)
        }
      }}
      role="button"
      tabIndex={0}
    >
      <div className={compact ? 'flex flex-shrink-0 items-center gap-2' : 'flex items-center gap-2'}>
        <AgentAvatar agent={agent} size="xs" token={token} />
        <span className="text-xs font-semibold text-[var(--tx2)]">{agentName}</span>
        <span className="thinking-dots" aria-hidden="true">
          <span />
          <span />
          <span />
        </span>
      </div>
      {ticker}
    </div>
  )
}
