import { useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAgents } from '../facades/agents/hooks'
import type { AgentRecord } from '../lib/api-client'

const sectionTitle =
  'text-xs font-semibold uppercase tracking-[0.2em] text-[color:var(--tx3)]'

const isActiveStatus = (status: AgentRecord['status']): boolean =>
  status === 'thinking' || status === 'executing' || status === 'waiting_approval'

const formatTimestamp = (value?: string) =>
  value ? new Date(value).toLocaleString() : '—'

const formatHierarchyLabel = (input: {
  agentId: string
  parentAgentId?: string | null
  parentName?: string
}): string => {
  if (input.parentAgentId) {
    return `sub-agent of ${input.parentName ?? input.parentAgentId.slice(0, 8)}`
  }

  return `root agent ${input.agentId.slice(0, 8)}`
}

const statusToneClass = (status: AgentRecord['status']): string => {
  switch (status) {
    case 'executing':
    case 'thinking':
      return 'text-emerald-300'
    case 'waiting_approval':
      return 'text-amber-300'
    case 'error':
      return 'text-rose-300'
    case 'offline':
      return 'text-[color:var(--tx3)]'
    default:
      return 'text-sky-300'
  }
}

type AgentCardProps = {
  agent: AgentRecord
  onCreateChild: (agentId: string) => void
  onEdit: (agentId: string) => void
  parentName?: string
}

const AgentCard = ({
  agent,
  onCreateChild,
  onEdit,
  parentName,
}: AgentCardProps) => (
  <div className="rounded-xl border border-[color:var(--sep)] bg-black/10 p-3">
    <div className="flex items-center justify-between gap-3">
      <div>
        <div className="font-semibold text-white">{agent.name}</div>
        <div className="text-xs text-[color:var(--tx3)]">
          {agent.role} · {formatHierarchyLabel({
            agentId: agent.id,
            parentAgentId: agent.parentAgentId,
            parentName,
          })}
        </div>
      </div>
      <span
        className={`text-xs uppercase tracking-[0.16em] ${statusToneClass(agent.status)}`}
      >
        {agent.status}
      </span>
    </div>

    <div className="mt-2 text-sm text-[color:var(--tx2)]">
      Last activity: {formatTimestamp(agent.lastActivityAt)}
    </div>
    <div className="mt-1 text-xs text-[color:var(--tx3)]">
      Bound channels: {agent.channelIds.length}
    </div>

    <div className="mt-3 flex items-center gap-2">
      <button
        className="admin-button admin-button-secondary"
        onClick={() => onEdit(agent.id)}
        type="button"
      >
        Edit
      </button>
      <button
        className="admin-button admin-button-secondary"
        onClick={() => onCreateChild(agent.id)}
        type="button"
      >
        Create sub-agent
      </button>
    </div>
  </div>
)

export const AgentsPage = () => {
  const navigate = useNavigate()
  const { data: agents = [] } = useAgents()

  const agentsById = useMemo(
    () => new Map(agents.map((agent) => [agent.id, agent])),
    [agents],
  )

  const sortedAgents = useMemo(() => {
    return [...agents].sort((left, right) => {
      if (Boolean(left.parentAgentId) !== Boolean(right.parentAgentId)) {
        return left.parentAgentId ? 1 : -1
      }

      const leftParent = left.parentAgentId
        ? agentsById.get(left.parentAgentId)?.name ?? left.parentAgentId
        : ''
      const rightParent = right.parentAgentId
        ? agentsById.get(right.parentAgentId)?.name ?? right.parentAgentId
        : ''

      const parentCompare = leftParent.localeCompare(rightParent)
      if (parentCompare !== 0) {
        return parentCompare
      }

      return left.name.localeCompare(right.name)
    })
  }, [agents, agentsById])

  const activeAgents = useMemo(
    () => sortedAgents.filter((agent) => isActiveStatus(agent.status)),
    [sortedAgents],
  )

  const subAgentCount = useMemo(
    () => sortedAgents.filter((agent) => agent.parentAgentId).length,
    [sortedAgents],
  )

  return (
    <section className="flex h-full min-h-0 flex-col">
      <header className="flex h-[50px] items-center justify-between gap-4 border-b border-[color:var(--sep)] px-5">
        <div className="flex items-center gap-4">
          <div className={sectionTitle}>Agents</div>
          <div className="rounded-full bg-white/5 px-2 py-0.5 text-xs text-[color:var(--tx2)]">
            {sortedAgents.length} total
          </div>
          <div className="rounded-full bg-white/5 px-2 py-0.5 text-xs text-[color:var(--tx2)]">
            {activeAgents.length} active
          </div>
          <div className="rounded-full bg-white/5 px-2 py-0.5 text-xs text-[color:var(--tx2)]">
            {subAgentCount} sub-agents
          </div>
        </div>
        <button
          className="admin-button admin-button-primary"
          onClick={() => void navigate('/agents/designer')}
          type="button"
        >
          New agent
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <div className="grid gap-4 lg:grid-cols-[1.2fr_0.8fr]">
          <div className="admin-card p-4">
            <div className={sectionTitle}>All agents</div>
            <div className="mt-3 grid gap-3">
              {sortedAgents.map((agent) => (
                <AgentCard
                  agent={agent}
                  key={agent.id}
                  onCreateChild={(agentId) =>
                    void navigate(`/agents/designer?parentId=${agentId}`)
                  }
                  onEdit={(agentId) => void navigate(`/agents/designer/${agentId}`)}
                  parentName={
                    agent.parentAgentId
                      ? agentsById.get(agent.parentAgentId)?.name
                      : undefined
                  }
                />
              ))}
              {sortedAgents.length === 0 && (
                <div className="py-8 text-center text-[color:var(--tx3)]">
                  No agents yet
                </div>
              )}
            </div>
          </div>

          <div className="admin-card p-4">
            <div className={sectionTitle}>Active now</div>
            <div className="mt-3 grid gap-3">
              {activeAgents.map((agent) => (
                <AgentCard
                  agent={agent}
                  key={agent.id}
                  onCreateChild={(agentId) =>
                    void navigate(`/agents/designer?parentId=${agentId}`)
                  }
                  onEdit={(agentId) => void navigate(`/agents/designer/${agentId}`)}
                  parentName={
                    agent.parentAgentId
                      ? agentsById.get(agent.parentAgentId)?.name
                      : undefined
                  }
                />
              ))}
              {activeAgents.length === 0 && (
                <div className="py-8 text-center text-[color:var(--tx3)]">
                  No agents are active right now
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
