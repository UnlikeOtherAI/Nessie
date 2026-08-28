import { faChevronRight } from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import type { AgentRecord } from '../../../lib/api-client'
import { AgentAvatar } from '../../shared/AgentAvatar'
import { AgentRowMenu } from './AgentRowMenu'

type AgentListRowProps = {
  agent: AgentRecord
  onEdit: (agentId: string) => void
  onOpen: (agentId: string) => void
  // Whether the editable ⋯ menu is offered. False for read-only global agents.
  showMenu: boolean
  token: string | null
}

// One agent row: avatar, the agent's name over a short job description, an
// optional ⋯ edit menu, and a far-right chevron. Nothing else lives on the row —
// the whole row opens the agent's detail; the chevron is the visible affordance
// for it, and the ⋯ menu stops propagation so its actions do not also open detail.
export const AgentListRow = ({
  agent,
  onEdit,
  onOpen,
  showMenu,
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
    <td className="w-10 px-1 py-2.5 text-right align-middle">
      {showMenu ? (
        <div className="flex justify-end">
          <AgentRowMenu
            agentName={agent.name}
            items={[
              {
                id: 'edit',
                label: 'Edit in designer',
                onSelect: () => onEdit(agent.id),
              },
            ]}
          />
        </div>
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
