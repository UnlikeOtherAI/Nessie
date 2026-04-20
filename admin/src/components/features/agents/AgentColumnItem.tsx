import type { AgentChild } from '@nessie/schemas'
import type { AgentRecord } from '../../../lib/api-client'
import { ColumnBrowserItem } from '../../shared/column-browser/ColumnBrowserItem'
import { AgentStatusDot } from './AgentStatusDot'

type AgentColumnItemProps = {
  agent: AgentRecord | AgentChild
  childCount?: number
  isSelected: boolean
  onClick: () => void
}

const getName = (agent: AgentRecord | AgentChild): string => agent.name

const getRole = (agent: AgentRecord | AgentChild): string =>
  'role' in agent && typeof agent.role === 'string'
    ? agent.role
    : 'purpose' in agent
      ? agent.purpose ?? 'assistant'
      : 'assistant'

const getMeta = (
  agent: AgentRecord | AgentChild,
  childCount: number,
): string => {
  if ('lastActivityAt' in agent) {
    return `Last activity ${new Date(agent.lastActivityAt).toLocaleString()}`
  }

  if ('purpose' in agent && agent.purpose) {
    return agent.purpose
  }

  return childCount > 0
    ? `${childCount} sub-agent${childCount === 1 ? '' : 's'}`
    : 'No sub-agents'
}

export const AgentColumnItem = ({
  agent,
  childCount = 0,
  isSelected,
  onClick,
}: AgentColumnItemProps) => (
  <ColumnBrowserItem
    caption={
      childCount > 0
        ? `${childCount} sub-agent${childCount === 1 ? '' : 's'}`
        : 'Leaf agent'
    }
    isSelected={isSelected}
    meta={<AgentStatusDot status={agent.status} />}
    onClick={onClick}
    subtitle={getRole(agent)}
    title={getName(agent)}
  >
    {getMeta(agent, childCount)}
  </ColumnBrowserItem>
)
