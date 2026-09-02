import { faPlus } from '@fortawesome/free-solid-svg-icons'
import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAgents } from '../../../facades/agents/hooks'
import { useScrollMemory } from '../../../hooks/useScrollMemory'
import type { AgentRecord } from '../../../lib/api-client'
import { useAuthSession } from '../../../providers/AuthSessionProvider'
import { useTabParam } from '../../../navigation/useTabParam'
import { TabBar } from '../../primitives/TabBar'
import { PaginationFooter } from '../../shared/PaginationFooter'
import { ScreenHeader } from '../../shared/ScreenHeader'
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
  // `scope` in the URL, seeded from the session ledger: a pasted
  // `/agents?scope=personal` opens on Personal, and arriving with no param
  // restores the scope this reader left on (docs/navigation/overview.md §1, "Tab hosts").
  const [activeScope, setActiveScope] = useTabParam(
    'scope',
    AGENT_SCOPES,
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
      {/* The Agents root is a Tab host: the scope strip is the header's own
          tabs slot and the scope description its subtitle, so the section
          has one header rather than a hero plus the route's own bar. */}
      <ScreenHeader
        actions={[{
          icon: faPlus,
          id: 'new-agent',
          label: 'New agent',
          onSelect: () => void navigate('/agents/designer'),
          primary: true,
          priority: 100,
        }]}
        subtitle={
          <p className="text-sm text-[color:var(--tx3)]">
            {AGENT_SCOPE_META[activeScope].description}
          </p>
        }
        tabs={
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
        }
        title="Agents"
      />

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
