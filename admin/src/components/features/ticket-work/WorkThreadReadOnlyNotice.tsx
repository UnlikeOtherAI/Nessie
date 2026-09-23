import { Link } from 'react-router-dom'

/**
 * The composer of a ticket's work thread, for someone who cannot edit the
 * ticket's board (docs/standards/ticket-work.md → "The work thread"). What is
 * written there steers the agent's work, so only the people who may start it
 * write there; the server refuses anyone else, and this says so before they
 * type — with the door they do have: the ticket's comments.
 */

export type WorkThreadReadOnly = { taskTitle: string; ticketHref: string }

export const WORK_THREAD_READ_ONLY_LINE = 'Comment on the ticket to give the agent more information.'

export const WorkThreadReadOnlyNotice = ({ taskTitle, ticketHref }: WorkThreadReadOnly) => (
  <div
    className="flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-[color:var(--bd)] px-4 py-3 text-xs text-[color:var(--tx3)]"
    data-testid="work-thread-read-only"
    role="status"
  >
    <span>
      Only people who can edit this ticket’s board write in its work thread. {WORK_THREAD_READ_ONLY_LINE}
    </span>
    <Link className="font-semibold text-[color:var(--lnk)] hover:underline" to={ticketHref}>
      Open {taskTitle}
    </Link>
  </div>
)
