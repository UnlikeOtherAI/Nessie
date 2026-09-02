import type { AgentChild } from '@nessie/schemas'
import { AgentRow } from '../../shared/AgentRow'
import { EmptyState } from '../../shared/EmptyState'
import { SectionLabel } from '../../primitives/SectionLabel'
import { AgentStatusDot } from './AgentStatusDot'

type SubAgentTreeProps = {
  onSelect: (agentId: string) => void
  selectedAgentId?: string | null
  subAgents: AgentChild[]
}

export const SubAgentTree = ({ onSelect, selectedAgentId, subAgents }: SubAgentTreeProps) => (
  <section className="grid gap-3">
    <SectionLabel>Sub-agent tree</SectionLabel>
    {subAgents.length === 0 ? (
      <EmptyState>This agent has no team members yet.</EmptyState>
    ) : (
      subAgents.map((agent) => (
        <div
          key={agent.agentId}
          className={`rounded-[1.5rem] border ${
            selectedAgentId === agent.agentId
              ? 'border-[color:var(--accent)] bg-[var(--accent-soft)]'
              : 'border-[color:var(--line)]/0'
          }`}
        >
          <AgentRow
            currentTask={agent.purpose}
            footer={agent.purpose ?? 'team member'}
            onClick={() => onSelect(agent.agentId)}
            statusDot={<AgentStatusDot status={agent.status} />}
            subtitle="team member"
            title={agent.name}
          />
        </div>
      ))
    )}
  </section>
)
