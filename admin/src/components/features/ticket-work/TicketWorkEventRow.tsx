import { faBellSlash, faBolt, faCircleStop } from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import {
  TICKET_WORK_THREAD_EVENT_LABELS,
  TicketWorkThreadEventSchema,
  type TicketWorkThreadEvent,
} from '@nessie/schemas'

import type { ThreadMessageRecord } from '../../../lib/api-client'
import { formatClock } from '../channels/channel-feed'

/**
 * One compact row in a ticket's work thread for each thing that happened to
 * the work — why the agent woke, why the platform stopped it, or who cancelled
 * its reminder
 * (docs/standards/ticket-work.md → "What the project sees"). A `system`
 * message the feed admits by its `metadata.ticketWorkEvent`; it is not a
 * model message, so it has no author, no avatar and no actions.
 */

/** The event a feed row carries, or null for every other message. */
export const ticketWorkEventOf = (message: ThreadMessageRecord): TicketWorkThreadEvent | null => {
  if (message.role !== 'system') return null
  const parsed = TicketWorkThreadEventSchema.safeParse(message.metadata?.ticketWorkEvent)
  return parsed.success ? parsed.data : null
}

// A document review's wake (`document_woken`) reads as a wake.
const EVENT_ICON = {
  woken: faBolt,
  stopped: faCircleStop,
  document_woken: faBolt,
  reminder_cancelled: faBellSlash,
} as const
const EVENT_ICON_TONE = {
  woken: 'text-[color:var(--info-text)]',
  stopped: 'text-[color:var(--danger-text)]',
  document_woken: 'text-[color:var(--info-text)]',
  reminder_cancelled: 'text-[color:var(--tx3)]',
} as const satisfies Record<TicketWorkThreadEvent['kind'], string>

export const TicketWorkEventRow = ({
  event,
  message,
}: {
  event: TicketWorkThreadEvent
  message: ThreadMessageRecord
}) => (
  <div
    className="flex items-start gap-2 px-5 py-1 text-xs text-[color:var(--tx3)]"
    data-testid="ticket-work-event-row"
    data-work-event={event.kind}
    role="status"
  >
    <FontAwesomeIcon
      aria-hidden
      className={`mt-0.5 h-3 w-3 shrink-0 ${EVENT_ICON_TONE[event.kind]}`}
      icon={EVENT_ICON[event.kind]}
    />
    <span className="min-w-0 flex-1 break-words">
      <span className="font-semibold text-[color:var(--tx2)]">{TICKET_WORK_THREAD_EVENT_LABELS[event.kind]}:</span>{' '}
      {event.summary}
    </span>
    <time className="shrink-0 tabular-nums" dateTime={message.createdAt}>{formatClock(message.createdAt)}</time>
  </div>
)
