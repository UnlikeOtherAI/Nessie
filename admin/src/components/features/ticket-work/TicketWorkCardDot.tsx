import type { TicketWorkCardRecord } from '@nessie/schemas'

import { useAuthSession } from '../../../providers/AuthSessionProvider'
import { AgentAvatar } from '../../shared/AgentAvatar'
import {
  TICKET_WORK_STATE_REASON_LABEL,
  TICKET_WORK_STATUS_DOT,
  TICKET_WORK_STATUS_LABEL,
} from './ticket-work-presentation'

/**
 * A board card's compact work state: the agent's avatar with a state dot
 * (docs/standards/ticket-work.md → "What the project sees"). The words are its
 * accessible name and tooltip; the ticket dialog's chip says the rest.
 */
export const TicketWorkCardDot = ({ work }: { work: TicketWorkCardRecord }) => {
  const { token } = useAuthSession()
  const reason = work.stateReason ? ` — ${TICKET_WORK_STATE_REASON_LABEL[work.stateReason]}` : ''
  const label = `${work.agentName} · ${TICKET_WORK_STATUS_LABEL[work.status]}${reason}`
  return (
    <span
      aria-label={label}
      className="relative inline-flex shrink-0"
      data-testid="ticket-work-card-dot"
      data-work-status={work.status}
      role="img"
      title={label}
    >
      <AgentAvatar agentId={work.agentId} size={18} token={token} />
      <span
        aria-hidden
        className="absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full ring-2 ring-[color:var(--panel)]"
        style={{ background: TICKET_WORK_STATUS_DOT[work.status] }}
      />
    </span>
  )
}
