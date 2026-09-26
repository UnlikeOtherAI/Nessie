import type { AgentChild } from '@nessie/schemas'
import { AgentRow } from '../../shared/AgentRow'
import { AgentStatusDot } from '../../shared/AgentStatusDot'

type SubAgentTreeProps = {
  onSelect: (agentId: string) => void
  subAgents: AgentChild[]
}

/**
 * The helpers this agent started for parts of its work. Shown only when it
 * has any — an empty list of them answers no question anybody asks.
 */
export const SubAgentTree = ({ onSelect, subAgents }: SubAgentTreeProps) => (
  <ul className="grid gap-2">
    {subAgents.map((agent) => (
      <li key={agent.agentId}>
        <AgentRow
          currentTask={agent.purpose}
          footer={agent.purpose ?? 'Helper'}
          onClick={() => onSelect(agent.agentId)}
          statusDot={<AgentStatusDot status={agent.status} />}
          subtitle="Helper"
          title={agent.name}
        />
      </li>
    ))}
  </ul>
)
