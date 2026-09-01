import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAgents } from '../../../facades/agents/hooks'
import { useScrollMemory } from '../../../hooks/useScrollMemory'
import type { AgentRecord } from '../../../lib/api-client'
import { useAuthSession } from '../../../providers/AuthSessionProvider'
import { PhoneNavigationButton } from '../../../layouts/admin-shell/PhoneNavigationButton'
import { TabBar } from '../../primitives/TabBar'
import { PaginationFooter } from '../../shared/PaginationFooter'
import { AgentCreateButton } from './AgentCreateButton'
import { AgentsTable } from './AgentsTable'
import {
  AGENT_SCOPES,
  AGENT_SCOPE_META,
  getAgentScope,
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
  const { token } = useAuthSession()
  // `scope: 'all'` so the read-only system tier (the Personal Assistant + global
  // system agents) is available to bucket, not just the shared team agents.
  const { data: agents = [], isPending } = useAgents({ scope: 'all' })

  const [initialState] = useState(loadAgentsListState)
  const [activeScope, setActiveScope] = useState<AgentScope>(
    initialState.activeScope,
  )
  const [pageByScope, setPageByScope] = useState(initialState.pageByScope)

  useEffect(() => {
    saveAgentsListState({ activeScope, pageByScope })
  }, [activeScope, pageByScope])

  // Only root agents are listed; sub-agents are reached from the detail page.
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

  const rangeStart = scopeAgents.length === 0 ? 0 : page * PAGE_SIZE + 1
  const rangeEnd = Math.min((page + 1) * PAGE_SIZE, scopeAgents.length)

  return (
    <div className="flex h-full flex-col">
      {/* Hand-rolled: AdminPageHeader fixes the page title at text-[17px]
          font-bold inside an h-[50px] bar, and cannot express this 24px
          font-semibold hero over a scope description that changes with the tab. */}
      <header className="flex items-start gap-3 px-6 pt-6 pb-4">
        <PhoneNavigationButton />
        <div className="min-w-0 flex-1 space-y-1">
          {/* SectionLabel cannot express tracking-[0.18em] at text-xs (xs is 0.2em, 2xs is 11px). */}
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

      <div className="flex items-center border-b border-[color:var(--sep)] px-6 py-2">
        <TabBar
          ariaLabel="Agent scopes"
          items={AGENT_SCOPES.map((scope) => ({
            count: buckets[scope].length,
            label: AGENT_SCOPE_META[scope].label,
            value: scope,
          }))}
          onChange={setActiveScope}
          value={activeScope}
        />
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
          onOpen={(agentId) => void navigate(`/agents/${agentId}`)}
          token={token}
        />
      </div>

      {/* Always visible: an empty or single-page scope still shows the strip,
          so the table above it does not grow and shrink as pages change. */}
      <PaginationFooter
        canNext={page < totalPages - 1}
        canPrevious={page > 0}
        className="px-6 py-3"
        label={
          scopeAgents.length === 0
            ? 'No agents'
            : `${rangeStart}–${rangeEnd} of ${scopeAgents.length} · Page ${page + 1} of ${totalPages}`
        }
        onPageChange={setPage}
        page={page}
      />
    </div>
  )
}
