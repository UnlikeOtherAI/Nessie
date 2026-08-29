import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAgents } from '../../../facades/agents/hooks'
import { useScrollMemory } from '../../../hooks/useScrollMemory'
import type { AgentRecord } from '../../../lib/api-client'
import { useAuthSession } from '../../../providers/AuthSessionProvider'
import { PhoneNavigationButton } from '../../../layouts/admin-shell/PhoneNavigationButton'
import { AgentCreateButton } from './AgentCreateButton'
import { AgentDetailDrawer } from './AgentDetailDrawer'
import { AgentsTable } from './AgentsTable'
import {
  AGENT_SCOPES,
  AGENT_SCOPE_META,
  getAgentScope,
  isAgentScopeEditable,
  type AgentScope,
} from './agent-scope'
import { loadAgentsListState, saveAgentsListState } from './agents-list-state'

const PAGE_SIZE = 10

const emptyBuckets = (): Record<AgentScope, AgentRecord[]> => ({
  global: [],
  personal: [],
  team: [],
})

export const AgentsList = () => {
  const navigate = useNavigate()
  const { me, token } = useAuthSession()
  const isOwner = me?.user.roleIds.includes('owner') ?? false
  // `scope: 'all'` so the read-only system tier (the Personal Assistant + global
  // system agents) is available to bucket, not just the shared team agents.
  const { data: agents = [], isPending } = useAgents({ scope: 'all' })

  const [initialState] = useState(loadAgentsListState)
  const [activeScope, setActiveScope] = useState<AgentScope>(
    initialState.activeScope,
  )
  const [pageByScope, setPageByScope] = useState(initialState.pageByScope)
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null)

  useEffect(() => {
    saveAgentsListState({ activeScope, pageByScope })
  }, [activeScope, pageByScope])

  // Every agent, so the detail drawer can resolve a sub-agent the table row does
  // not itself list (children are returned by the same endpoint).
  const agentsById = useMemo(
    () => new Map(agents.map((agent) => [agent.id, agent])),
    [agents],
  )

  // Only root agents are listed; sub-agents are reached from the detail drawer.
  const buckets = useMemo(() => {
    const grouped = emptyBuckets()
    for (const agent of agents) {
      if (agent.parentAgentId) continue
      grouped[getAgentScope(agent)].push(agent)
    }
    for (const scope of AGENT_SCOPES) {
      grouped[scope].sort((left, right) => left.name.localeCompare(right.name))
    }
    return grouped
  }, [agents])

  const scopeAgents = buckets[activeScope]
  const totalPages = Math.max(1, Math.ceil(scopeAgents.length / PAGE_SIZE))
  const page = Math.min(pageByScope[activeScope], totalPages - 1)
  const pageAgents = scopeAgents.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE)

  const setPage = (next: number) => {
    setPageByScope((prev) => ({ ...prev, [activeScope]: next }))
  }

  const scroll = useScrollMemory(`agents:list:${activeScope}`)
  const selectedAgent = selectedAgentId
    ? agentsById.get(selectedAgentId) ?? null
    : null

  const rangeStart = scopeAgents.length === 0 ? 0 : page * PAGE_SIZE + 1
  const rangeEnd = Math.min((page + 1) * PAGE_SIZE, scopeAgents.length)

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-start gap-3 px-6 pt-6 pb-4">
        <PhoneNavigationButton />
        <div className="min-w-0 flex-1 space-y-1">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[color:var(--tx3)]">
            Agents
          </p>
          <h1 className="text-2xl font-semibold text-[color:var(--tx)]">Agents</h1>
          <p className="text-sm text-[color:var(--tx3)]">
            {AGENT_SCOPE_META[activeScope].description}
          </p>
        </div>
        <AgentCreateButton
          label="New agent"
          onClick={() => void navigate('/agents/designer')}
        />
      </header>

      <div
        className="flex items-center gap-1 border-b border-[color:var(--sep)] px-6"
        role="tablist"
      >
        {AGENT_SCOPES.map((scope) => (
          <button
            aria-selected={activeScope === scope}
            className={`admin-tab ${activeScope === scope ? 'active' : ''}`}
            key={scope}
            onClick={() => setActiveScope(scope)}
            role="tab"
            type="button"
          >
            {AGENT_SCOPE_META[scope].label}
            <span className="text-[color:var(--tx3)]">
              {buckets[scope].length}
            </span>
          </button>
        ))}
      </div>

      <div
        className="min-h-0 flex-1 overflow-y-auto px-6 py-4"
        onScroll={scroll.onScroll}
        ref={scroll.ref}
      >
        <AgentsTable
          agents={pageAgents}
          emptyMessage={AGENT_SCOPE_META[activeScope].empty}
          isLoading={isPending}
          onEdit={(agentId) => void navigate(`/agents/designer/${agentId}`)}
          onOpen={(agentId) => setSelectedAgentId(agentId)}
          showMenu={isAgentScopeEditable(activeScope) && isOwner}
          token={token}
        />
      </div>

      <div className="flex items-center justify-between border-t border-[color:var(--sep)] px-6 py-3">
        <button
          className="admin-button admin-button-secondary"
          disabled={page === 0}
          onClick={() => setPage(page - 1)}
          type="button"
        >
          Previous
        </button>
        <span className="text-xs text-[color:var(--tx3)]">
          {scopeAgents.length === 0
            ? 'No agents'
            : `${rangeStart}–${rangeEnd} of ${scopeAgents.length} · Page ${page + 1} of ${totalPages}`}
        </span>
        <button
          className="admin-button admin-button-secondary"
          disabled={page >= totalPages - 1}
          onClick={() => setPage(page + 1)}
          type="button"
        >
          Next
        </button>
      </div>

      <AgentDetailDrawer
        agent={selectedAgent}
        onClose={() => setSelectedAgentId(null)}
        onSelectAgent={(agentId) => setSelectedAgentId(agentId)}
      />
    </div>
  )
}
