import { faChevronRight, faTrash } from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import type { AgentRecord } from '../../../lib/api-client'
import { prewarmRowHandlers } from '../../../navigation/prewarm'
import { AgentAvatar } from '../../shared/AgentAvatar'
import { useCanDeleteAgent } from './agent-edit-authority'
import { AgentOwnerCell } from './AgentOwnerCell'
import { AgentVisibilityPill } from '../../shared/AgentVisibilityPill'
import { PrivateAgentHomeLink } from './PrivateAgentHomeLink'

type AgentListRowProps = {
  agent: AgentRecord
  /**
   * Opens the confirmation. Absent on a list that does not offer deletion at
   * all; present, it is still only drawn for an agent this viewer may edit, so
   * the control and `DELETE /api/agents/:agentId` agree.
   */
  onDelete?: (agent: AgentRecord) => void
  onOpen: (agentId: string) => void
  /** From the table's own `usePrewarm()`; a row cannot call a hook itself. */
  prewarm: (to: string) => void
  token: string | null
}

// One agent row: avatar, the agent's name over a short job description, an
// owner, and a far-right chevron. The whole row opens agent detail, which owns
// editing alongside the integrated Design Assistant.
export const AgentListRow = ({
  agent,
  onDelete,
  onOpen,
  prewarm,
  token,
}: AgentListRowProps) => {
  // The same answer the route resolves: never a system-managed agent, and never
  // somebody else's person-owned one unless this viewer administers the
  // organisation.
  const canDelete = useCanDeleteAgent(agent)

  return (
  <tr
    className="cursor-pointer"
    onClick={() => onOpen(agent.id)}
    tabIndex={0}
    {...prewarmRowHandlers(prewarm, `/agents/${agent.id}`)}
    onKeyDown={(event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        onOpen(agent.id)
      }
    }}
  >
    <td className="w-10 py-2.5 pl-4 pr-0 align-middle">
      <AgentAvatar agent={agent} size="sm" token={token} />
    </td>
    <td className="min-w-0 px-3 py-2.5 align-middle">
      <div className="flex min-w-0 items-center gap-2">
        <span className="truncate text-sm font-medium text-[color:var(--tx)]">
          {agent.name}
        </span>
        <AgentVisibilityPill visibility={agent.visibility} />
      </div>
      <div className="truncate text-xs text-[color:var(--tx3)]">
        {agent.role}
      </div>
      <PrivateAgentHomeLink
        agent={agent}
        className="mt-1 inline-flex text-xs text-[color:var(--lnk)] hover:underline"
        stopParentNavigation
      />
    </td>
    <td className="hidden w-44 px-3 py-2.5 align-middle sm:table-cell">
      <AgentOwnerCell
        owner={agent.owner}
        systemManaged={agent.systemManaged}
        token={token}
      />
    </td>
    <td className="w-9 py-2.5 pl-0 pr-1 text-right align-middle">
      {onDelete && canDelete ? (
        <button
          aria-label={`Delete ${agent.name}`}
          className="admin-msg-action-button"
          title={`Delete ${agent.name}`}
          onClick={(event) => {
            // The row itself opens the agent; a delete must not do both.
            event.stopPropagation()
            onDelete(agent)
          }}
          type="button"
        >
          <FontAwesomeIcon className="h-3 w-3" icon={faTrash} />
        </button>
      ) : null}
    </td>
    <td className="w-9 py-2.5 pl-0 pr-4 text-right align-middle">
      <FontAwesomeIcon
        className="h-3 w-3 text-[color:var(--tx3)]"
        icon={faChevronRight}
      />
    </td>
  </tr>
  )
}
