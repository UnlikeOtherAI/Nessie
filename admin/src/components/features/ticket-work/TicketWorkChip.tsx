import { useState } from 'react'
import { Link } from 'react-router-dom'
import type { TicketWorkChipRecord, TicketWorkHistoryEntry, TicketWorkSkipNotice } from '@nessie/schemas'

import { useCancelTicketWorkReminder, useTaskTicketWork } from '../../../facades/ticket-work/hooks'
import { useAuthSession } from '../../../providers/AuthSessionProvider'
import { AgentAvatar } from '../../shared/AgentAvatar'
import {
  refusedReentryOf,
  TICKET_WORK_STATUS_DOT,
  ticketSkipSentence,
  ticketWorkHeadline,
  ticketWorkHistoryLine,
  ticketWorkQuestionLine,
  ticketWorkReminderLine,
  ticketWorkStateLine,
  ticketWorkWakeLine,
} from './ticket-work-presentation'

/**
 * The work chip in the ticket dialog (docs/standards/ticket-work.md → "What
 * the project sees"): which agent works the ticket, where the work stands and
 * why, when it last woke and for what, the reminder it set (with Cancel for
 * whoever can edit the board) and a question it waits on, and the way into its
 * work thread for a reader who may open it. A reader who may not sees the
 * same state and no link. It names no machine.
 *
 * A move that started nothing is said here too, until work starts after it:
 * the person who moved the ticket is the one who needs to know. A move back
 * that left parked work parked is said on that work's own row instead. The
 * ticket's work history — each start, park, resume and end, and who caused
 * it — folds away beneath.
 */

/**
 * The agent's pending `check_back_in`, with Cancel for a viewer who can edit
 * the board. Everyone else who reads the ticket sees when the agent checks
 * back, and no door the route would refuse.
 */
const ReminderLine = ({ canCancel, record, taskId }: {
  canCancel: boolean
  record: TicketWorkChipRecord
  taskId: string
}) => {
  const cancel = useCancelTicketWorkReminder(taskId)
  const [failure, setFailure] = useState<string | null>(null)
  const line = ticketWorkReminderLine(record)
  if (!line || !record.pendingReminder) return null
  const reminderId = record.pendingReminder.id
  const press = () => {
    setFailure(null)
    cancel.mutate(reminderId, {
      // Said beside the reminder it was about, in the route's own words.
      onError: (error) => setFailure(error instanceof Error ? error.message : 'The reminder could not be cancelled.'),
    })
  }
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 text-xs text-[color:var(--tx2)]" data-testid="ticket-work-reminder">
      <span className="break-words">{line}</span>
      {canCancel ? (
        <button
          className="text-xs font-semibold text-[color:var(--lnk)] hover:underline disabled:opacity-60"
          disabled={cancel.isPending}
          onClick={press}
          type="button"
        >
          {cancel.isPending ? 'Cancelling…' : 'Cancel'}
        </button>
      ) : null}
      {failure ? <span className="basis-full text-[color:var(--danger-text)]" role="alert">{failure}</span> : null}
    </div>
  )
}

const WorkRow = ({ canCancelReminder, lastSkip, record, taskId }: {
  canCancelReminder: boolean
  lastSkip: TicketWorkSkipNotice | null
  record: TicketWorkChipRecord
  taskId: string
}) => {
  const { token } = useAuthSession()
  const wake = ticketWorkWakeLine(record)
  const state = ticketWorkStateLine(record, lastSkip)
  const question = ticketWorkQuestionLine(record)
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
        <ReminderLine canCancel={canCancelReminder} record={record} taskId={taskId} />
        {question ? (
          <div className="text-xs text-[color:var(--tx2)]" data-testid="ticket-work-question">{question}</div>
        ) : null}
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
  const canCancelReminder = data?.viewerCanEditBoard === true
  // A refused move back is said on the parked work's own row, not twice.
  const skipOnRow = records.some((record) => refusedReentryOf(record, lastSkip) !== null)
  if (records.length === 0 && !lastSkip && history.length === 0) return null
  return (
    <section aria-label="Agent work on this ticket" className="grid gap-2">
      {records.map((record) => (
        <WorkRow
          canCancelReminder={canCancelReminder}
          key={record.id}
          lastSkip={lastSkip}
          record={record}
          taskId={taskId}
        />
      ))}
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
