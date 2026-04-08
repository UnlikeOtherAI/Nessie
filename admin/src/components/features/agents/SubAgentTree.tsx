import type { AgentChild } from '@nessie/schemas'
import { AgentRow } from '../../shared/AgentRow'
import { EmptyState } from '../../shared/EmptyState'
import { AgentStatusDot } from './AgentStatusDot'

type SubAgentTreeProps = {
  onSelect: (agentId: string) => void
  selectedAgentId?: string | null
  subAgents: AgentChild[]
}

export const SubAgentTree = ({ onSelect, selectedAgentId, subAgents }: SubAgentTreeProps) => (
  <section className="grid gap-3">
    <div className="text-xs font-semibold uppercase tracking-[0.2em] text-[color:var(--muted)]">
      Sub-agent tree
    </div>
    {subAgents.length === 0 ? (
      <EmptyState>No sub-agents have been spawned from this agent yet.</EmptyState>
    ) : (
      subAgents.map((agent) => (
        <div
          key={agent.agentId}
          className={`rounded-[1.5rem] border ${
            selectedAgentId === agent.agentId
              ? 'border-[color:var(--accent)] bg-[color:var(--accent-soft)]/60'
              : 'border-transparent'
          }`}
        >
          <AgentRow
            currentTask={agent.purpose}
            footer={`spawned ${new Date(agent.spawnedAt).toLocaleString()}`}
            onClick={() => onSelect(agent.agentId)}
            statusDot={<AgentStatusDot status={agent.status} />}
            subtitle="sub-agent"
            title={agent.name}
          />
        </div>
      ))
    )}
  </section>
)
