import { Link } from 'react-router-dom'
import type { TicketWorkThreadMessageOutcome } from '@nessie/schemas'

/**
 * The composer of a ticket's work thread (docs/standards/ticket-work.md →
 * "The work thread"). What is written there steers the agent's work, so:
 *
 * - someone who cannot edit the ticket's board gets no composer — the server
 *   refuses them — and this says so before they type, with the door they do
 *   have: the ticket's comments;
 * - a board editor whose message would wake nobody — the work ended, its
 *   trigger is off or does not read thread messages — keeps the composer and
 *   is told that first, in the words the trigger's page uses for the skip.
 */

export type WorkThreadComposer = {
  taskTitle: string
  ticketHref: string
  /** The viewer cannot edit the ticket's board: no composer at all. */
  readOnly: boolean
  /** What a message here would do, when the viewer may write one. */
  messageOutcome: TicketWorkThreadMessageOutcome
}

export const WORK_THREAD_READ_ONLY_LINE = 'Comment on the ticket to give the agent more information.'

/** Said above a board editor's composer when a message would wake nobody — the skip it would be. */
export const WORK_THREAD_WAKES_NOBODY: Record<Exclude<TicketWorkThreadMessageOutcome, 'wakes'>, string> = {
  work_ended: 'This ticket’s work has ended, so a message here wakes nobody. '
    + 'Move the ticket into a start-work column to start it again.',
  not_followed: 'This ticket’s trigger does not read messages in its work thread, so a message here wakes nobody. '
    + 'Comment on the ticket instead.',
  trigger_disabled: 'This ticket’s trigger is off, so a message here wakes nobody.',
  config_invalid: 'This ticket’s trigger no longer matches its board, so a message here wakes nobody.',
}

const TicketLink = ({ taskTitle, ticketHref }: Pick<WorkThreadComposer, 'taskTitle' | 'ticketHref'>) => (
  <Link className="font-semibold text-[color:var(--lnk)] hover:underline" to={ticketHref}>
    Open {taskTitle}
  </Link>
)

export const WorkThreadReadOnlyNotice = ({ messageOutcome, readOnly, taskTitle, ticketHref }: WorkThreadComposer) => {
  const line = readOnly
    ? `Only people who can edit this ticket’s board write in its work thread. ${WORK_THREAD_READ_ONLY_LINE}`
    : messageOutcome === 'wakes' ? null : WORK_THREAD_WAKES_NOBODY[messageOutcome]
  if (!line) return null
  return (
    <div
      className="flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-[color:var(--bd)] px-4 py-3 text-xs text-[color:var(--tx3)]"
      data-message-outcome={readOnly ? undefined : messageOutcome}
      data-testid={readOnly ? 'work-thread-read-only' : 'work-thread-wakes-nobody'}
      role="status"
    >
      <span>{line}</span>
      <TicketLink taskTitle={taskTitle} ticketHref={ticketHref} />
    </div>
  )
}
