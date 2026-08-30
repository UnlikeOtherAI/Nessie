import { faChevronRight } from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import type { AgentRecord } from '../../../lib/api-client'
import { AgentAvatar } from '../../shared/AgentAvatar'
import { AgentOwnerCell } from './AgentOwnerCell'

type AgentListRowProps = {
  agent: AgentRecord
  onOpen: (agentId: string) => void
  token: string | null
}

// One agent row: avatar, the agent's name over a short job description, an
// owner, and a far-right chevron. The whole row opens agent detail, which owns
// editing alongside the integrated Design Assistant.
export const AgentListRow = ({
  agent,
  onOpen,
  token,
}: AgentListRowProps) => (
  <tr
    className="cursor-pointer"
    onClick={() => onOpen(agent.id)}
    tabIndex={0}
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
      <div className="truncate text-sm font-medium text-[color:var(--tx)]">
        {agent.name}
      </div>
      <div className="truncate text-xs text-[color:var(--tx3)]">
        {agent.role}
      </div>
    </td>
    <td className="hidden w-44 px-3 py-2.5 align-middle sm:table-cell">
      <AgentOwnerCell owner={agent.owner} token={token} />
    </td>
    <td className="w-9 py-2.5 pl-0 pr-4 text-right align-middle">
      <FontAwesomeIcon
        className="h-3 w-3 text-[color:var(--tx3)]"
        icon={faChevronRight}
      />
    </td>
  </tr>
)
