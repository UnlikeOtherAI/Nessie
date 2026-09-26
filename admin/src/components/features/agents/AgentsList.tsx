import { faPlus } from '@fortawesome/free-solid-svg-icons'
import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAgents, useStartAgentConversation } from '../../../facades/agents/hooks'
import { useDeleteAgent } from '../../../facades/agents/mutations'
import { formErrorMessage } from '../../../facades/forms/form-errors'
import { useScrollMemory } from '../../../hooks/useScrollMemory'
import type { AgentRecord } from '../../../lib/api-client'
import { useAuthSession } from '../../../providers/AuthSessionProvider'
import { useTabParam } from '../../../navigation/useTabParam'
import { TabBar } from '../../primitives/TabBar'
import { PaginationFooter } from '../../shared/PaginationFooter'
import { ScreenHeader } from '../../shared/ScreenHeader'
import { ConfirmDialog } from '../../shared/ConfirmDialog'
import { useToasts } from '../../../providers/ToastProvider'
import { AgentsTable } from './AgentsTable'
import {
  AGENT_LIST_TABS,
  AGENT_LIST_TAB_META,
  agentListTab,
  type AgentListTab,
} from './agents-list-tabs'
import { loadAgentsListState, saveAgentsListState } from './agents-list-state'
import { conversationPath } from './conversations/AgentConversationList'
import { privateAgentHomeChannelId } from './PrivateAgentHomeLink'

const emptyBuckets = (): Record<AgentListTab, AgentRecord[]> => ({
  'built-in': [],
  mine: [],
  shared: [],
})

export const AgentsList = () => {
  const navigate = useNavigate()
  const { token } = useAuthSession()
  // `scope: 'all'` so the read-only system tier (the Personal Assistant + global
  // system agents) is available to bucket, not just the shared team agents.
  const { data: agents = [], isPending } = useAgents({ scope: 'all' })

  const [initialState] = useState(loadAgentsListState)
  // `scope` in the URL, seeded from the session ledger: a pasted
  // `/admin/agents?scope=mine` opens on Mine, and arriving with no param
  // restores the tab this reader left on (docs/navigation/overview.md §1, "Tab hosts").
  const [activeTab, setActiveTab] = useTabParam(
    'scope',
    AGENT_LIST_TABS,
    initialState.activeTab,
  )
  const [pageByTab, setPageByTab] = useState(initialState.pageByTab)
  const [pageSize, setPageSize] = useState(initialState.pageSize)
  // Agents → Admin is the owning surface for deleting an agent (Rule zero: it
  // is where a person already stands when the question arises). The row draws
  // the control only for an agent they may edit; this owns the confirmation and
  // the failure message.
  const [pendingDelete, setPendingDelete] = useState<AgentRecord | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const deleteAgent = useDeleteAgent()
  const startConversation = useStartAgentConversation()
  const { pushToast } = useToasts()

  useEffect(() => {
    saveAgentsListState({ activeTab, pageByTab, pageSize })
  }, [activeTab, pageByTab, pageSize])

  // Only root agents are listed; the helpers an agent starts are reached from
  // its page.
  const buckets = useMemo(() => {
    const grouped = emptyBuckets()
    for (const agent of agents) {
      if (agent.parentAgentId) continue
      grouped[agentListTab(agent)].push(agent)
    }
    for (const tab of AGENT_LIST_TABS) {
      grouped[tab].sort((left, right) => left.name.localeCompare(right.name))
    }
    return grouped
  }, [agents])

  const scopeAgents = buckets[activeTab]
  const totalPages = Math.max(1, Math.ceil(scopeAgents.length / pageSize))
  const page = Math.min(pageByTab[activeTab], totalPages - 1)
  const pageAgents = scopeAgents.slice(page * pageSize, page * pageSize + pageSize)

  const setPage = (next: number) => {
    setPageByTab((prev) => ({ ...prev, [activeTab]: next }))
  }
  const setPageSizeAndReset = (next: number) => {
    setPageSize(next)
    setPageByTab((previous) => ({ ...previous, [activeTab]: 0 }))
  }

  // A private agent lives in its owner's one conversation; any other is met
  // in a fresh conversation, or the empty one the person already has.
  const openConversation = (agent: AgentRecord) => {
    const home = privateAgentHomeChannelId(agent)
    if (home) {
      void navigate(`/channels/${home}`)
      return
    }
    startConversation.mutate({ agentId: agent.id }, {
      onError: (error) => pushToast({
        body: formErrorMessage(error, 'A conversation with this agent could not be opened.'),
        title: 'No conversation opened',
      }),
      onSuccess: (result) => void navigate(conversationPath(result.conversation)),
    })
  }

  const scroll = useScrollMemory(`agents:list:${activeTab}`)

  const rangeStart = scopeAgents.length === 0 ? 0 : page * pageSize + 1
  const rangeEnd = Math.min((page + 1) * pageSize, scopeAgents.length)

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
          onSelect: () => void navigate('/admin/agents/new'),
          primary: true,
          priority: 100,
        }]}
        subtitle={
          <p className="text-sm text-[color:var(--tx3)]" data-testid="agents-tab-note">
            {AGENT_LIST_TAB_META[activeTab].description}
          </p>
        }
        tabs={
          <TabBar
            ariaLabel="Whose agents"
            items={AGENT_LIST_TABS.map((tab) => ({
              count: buckets[tab].length,
              label: AGENT_LIST_TAB_META[tab].label,
              value: tab,
            }))}
            onChange={setActiveTab}
            value={activeTab}
          />
        }
        title="Agents"
      />

      <div
        className="min-h-0 flex-1 overflow-y-auto px-[var(--page-gutter)] py-4"
        onScroll={scroll.onScroll}
        ref={scroll.ref}
      >
        <AgentsTable
          agents={pageAgents}
          emptyMessage={AGENT_LIST_TAB_META[activeTab].empty}
          isLoading={isPending}
          onDelete={(agent) => {
            setDeleteError(null)
            setPendingDelete(agent)
          }}
          onMessage={openConversation}
          onOpen={(agentId) => void navigate(`/admin/agents/${agentId}`)}
          token={token}
        />
      </div>

      <ConfirmDialog
        body={
          <div className="grid gap-2">
            <p>
              {pendingDelete
                ? `${pendingDelete.name} will stop working: it is removed from every `
                  + 'channel it was placed in, its schedules are deleted, and any run '
                  + 'it has in flight is cancelled. Its past work stays in the record.'
                : ''}
            </p>
            {deleteError ? (
              <p className="text-[color:var(--danger-text)]" role="alert">{deleteError}</p>
            ) : null}
          </div>
        }
        confirmLabel="Delete agent"
        destructive
        onCancel={() => {
          setPendingDelete(null)
          setDeleteError(null)
        }}
        onConfirm={() => {
          if (!pendingDelete) return
          void (async () => {
            try {
              await deleteAgent.mutateAsync(pendingDelete.id)
              setPendingDelete(null)
            } catch (error) {
              // The server is the authority; its refusal belongs on the dialog
              // rather than in a rejected promise nobody sees.
              setDeleteError(
                error instanceof Error ? error.message : 'Unable to delete this agent.',
              )
            }
          })()
        }}
        open={pendingDelete !== null}
        pending={deleteAgent.isPending}
        title={pendingDelete ? `Delete ${pendingDelete.name}?` : 'Delete agent?'}
      />

      {/* Always visible: an empty or single-page scope keeps its size control,
          and the table above it does not grow and shrink as pages change. */}
      <PaginationFooter
        canNext={page < totalPages - 1}
        canPrevious={page > 0}
        className="px-6 py-3"
        label={
          scopeAgents.length === 0
            ? 'No agents'
            : `${rangeStart}–${rangeEnd} of ${scopeAgents.length}`
        }
        onPageChange={setPage}
        onPageSizeChange={setPageSizeAndReset}
        page={page}
        pageCount={totalPages}
        pageSize={pageSize}
      />
    </div>
  )
}
