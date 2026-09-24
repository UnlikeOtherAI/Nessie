import { Link } from 'react-router-dom'
import type { TicketWorkChipRecord, TicketWorkHistoryEntry, TicketWorkSkipNotice } from '@nessie/schemas'

import { useTaskTicketWork } from '../../../facades/ticket-work/hooks'
import { useAuthSession } from '../../../providers/AuthSessionProvider'
import { AgentAvatar } from '../../shared/AgentAvatar'
import {
  refusedReentryOf,
  TICKET_WORK_STATUS_DOT,
  ticketSkipSentence,
  ticketWorkHeadline,
  ticketWorkHistoryLine,
  ticketWorkStateLine,
  ticketWorkWakeLine,
} from './ticket-work-presentation'

/**
 * The work chip in the ticket dialog (docs/standards/ticket-work.md → "What
 * the project sees"): which agent works the ticket, where the work stands and
 * why, when it last woke and for what, and the way into its work thread for a
 * reader who may open it. A reader who may not sees the same state and no
 * link. It names no machine.
 *
 * A move that started nothing is said here too, until work starts after it:
 * the person who moved the ticket is the one who needs to know. A move back
 * that left parked work parked is said on that work's own row instead. The
 * ticket's work history — each start, park, resume and end, and who caused
 * it — folds away beneath.
 */

const WorkRow = ({ lastSkip, record }: { lastSkip: TicketWorkSkipNotice | null; record: TicketWorkChipRecord }) => {
  const { token } = useAuthSession()
  const wake = ticketWorkWakeLine(record)
  const state = ticketWorkStateLine(record, lastSkip)
  return (
    <div
      className="flex items-start gap-2.5 rounded-lg border border-[color:var(--sep)] bg-[color:var(--main)] px-3 py-2"
      data-testid="ticket-work-chip"
      data-work-status={record.status}
    >
      <span className="relative mt-0.5 inline-flex shrink-0">
        <AgentAvatar agentId={record.agent.id} size="xs" token={token} />
        <span
          aria-hidden
          className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full ring-2 ring-[color:var(--main)]"
          style={{ background: TICKET_WORK_STATUS_DOT[record.status] }}
        />
      </span>
      <div className="grid min-w-0 flex-1 gap-0.5">
        <div className="break-words text-sm font-semibold text-[color:var(--tx)]" data-testid="ticket-work-headline">
          {ticketWorkHeadline(record)}
        </div>
        {record.startedByName ? (
          <div className="text-xs text-[color:var(--tx3)]">Started by {record.startedByName}</div>
        ) : null}
        {wake ? <div className="text-xs text-[color:var(--tx2)]">{wake}</div> : null}
        {state ? (
          <div
            className={`text-xs ${record.status === 'failed' ? 'text-[color:var(--danger-text)]' : 'text-[color:var(--tx2)]'}`}
          >
            {state}
          </div>
        ) : null}
        {record.thread ? (
          <Link
            className="mt-0.5 justify-self-start text-xs font-semibold text-[color:var(--lnk)] hover:underline"
            to={`/channels/${encodeURIComponent(record.thread.channelId)}/threads/${encodeURIComponent(record.thread.id)}`}
          >
            Open the work thread
          </Link>
        ) : null}
      </div>
    </div>
  )
}

const WorkHistory = ({ history }: { history: TicketWorkHistoryEntry[] }) => (
  <details className="group text-xs text-[color:var(--tx2)]" data-testid="ticket-work-history">
    <summary className="cursor-pointer select-none font-semibold text-[color:var(--tx2)] hover:text-[color:var(--tx)]">
      Work history ({history.length})
    </summary>
    <ol className="mt-1.5 grid gap-1 border-l border-[color:var(--sep)] pl-3">
      {history.map((entry) => (
        <li className="break-words" data-work-event={entry.eventType} key={entry.id}>
          {ticketWorkHistoryLine(entry)}
        </li>
      ))}
    </ol>
  </details>
)

export const TicketWorkChip = ({ taskId }: { taskId: string }) => {
  const { data } = useTaskTicketWork(taskId)
  const records = data?.records ?? []
  const lastSkip = data?.lastSkip ?? null
  const history = data?.history ?? []
  // A refused move back is said on the parked work's own row, not twice.
  const skipOnRow = records.some((record) => refusedReentryOf(record, lastSkip) !== null)
  if (records.length === 0 && !lastSkip && history.length === 0) return null
  return (
    <section aria-label="Agent work on this ticket" className="grid gap-2">
      {records.map((record) => <WorkRow key={record.id} lastSkip={lastSkip} record={record} />)}
      {lastSkip && !skipOnRow ? (
        <p
          className="rounded-lg border border-dashed border-[color:var(--sep)] px-3 py-2 text-xs text-[color:var(--tx2)]"
          data-testid="ticket-work-skip"
        >
          <span className="font-semibold text-[color:var(--tx)]">{lastSkip.agentName}:</span>{' '}
          {ticketSkipSentence(lastSkip.reason, { reentry: lastSkip.reentry })}
        </p>
      ) : null}
      {history.length > 0 ? <WorkHistory history={history} /> : null}
    </section>
  )
}
