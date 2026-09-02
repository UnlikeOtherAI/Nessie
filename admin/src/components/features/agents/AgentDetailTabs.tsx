import { type ReactNode, useEffect, useMemo, useState } from 'react'
import {
  useAgentActivity,
  useAgentChildren,
  useAgentMessages,
  useAgentStatus,
} from '../../../facades/agents/hooks'
import type { AgentRecord } from '../../../lib/api-client'
import { useTabParam } from '../../../navigation/useTabParam'
import { SectionLabel } from '../../primitives/SectionLabel'
import { TabBar, type TabBarItem } from '../../primitives/TabBar'
import { EmptyState } from '../../shared/EmptyState'
import { PaginationFooter } from '../../shared/PaginationFooter'
import { AgentBrowserPanel } from '../browser-cloud/AgentBrowserPanel'
import { AgentAvailableTools } from './AgentAvailableTools'
import { AgentDocumentsTab } from './AgentDocumentsTab'
import { AgentMessagePreview } from './AgentMessagePreview'
import { AgentThoughtStream } from './AgentThoughtStream'
import { AgentTriggerPanel } from './AgentTriggerPanel'
import { SubAgentTree } from './SubAgentTree'
import { AgentEmailSection } from './AgentEmailSection'
import { ToolExecutionLog } from './ToolExecutionLog'
import { AgentTodosTab } from './todos/AgentTodosTab'
import {
  useDesignerAssistantPanel,
  type DesignerPageContext,
} from './designer/DesignerAssistantPanelContext'

type Tab =
  | 'edit'
  | 'activity'
  | 'sub-agents'
  | 'tools'
  | 'messages'
  | 'documents'
  | 'email'
  | 'to-dos'

// To-dos sits first here so that on an owner's view — where Edit is prepended —
// it reads as the second tab, right beside the configuration it belongs to.
const FIRST_DETAIL_TAB: Tab = 'to-dos'

const DETAIL_TABS: ReadonlyArray<TabBarItem<Tab>> = [
  { label: 'To-dos', value: FIRST_DETAIL_TAB },
  { label: 'Activity', value: 'activity' },
  { label: 'Sub-Agents', value: 'sub-agents' },
  { label: 'Tools', value: 'tools' },
  { label: 'Messages', value: 'messages' },
  { label: 'Documents', value: 'documents' },
  { label: 'Email', value: 'email' },
]

const PAGE_SIZE = 10

const pageContextForTab: Record<Tab, DesignerPageContext> = {
  edit: {
    actions: ['edit the agent configuration'],
    description: 'Configure this agent’s identity, model, instructions, and run limits.',
    title: 'Edit agent',
  },
  activity: {
    actions: [],
    description: 'Review this agent’s current run, triggers, recent tool calls, and thought stream.',
    title: 'Activity',
  },
  'sub-agents': {
    actions: [],
    description: 'Review and navigate this agent’s delegated sub-agents.',
    title: 'Sub-Agents',
  },
  tools: {
    actions: ['enable or disable tools, then save the changes'],
    description: 'Review this agent’s available tools and change its tool access.',
    title: 'Tools',
  },
  messages: {
    actions: [],
    description: 'Review messages this agent has sent or received.',
    title: 'Messages',
  },
  documents: {
    actions: ['review and edit the agent’s documents and manage its document space'],
    description: 'Review the versioned documents this agent keeps and shares with its viewers.',
    title: 'Documents',
  },
  email: {
    actions: ['give the agent an email address and choose how much it may send on its own'],
    description:
      'This agent’s own mailbox: its address, how much it may send without a person, '
      + 'and the way into its correspondence.',
    title: 'Email',
  },
  'to-dos': {
    actions: [],
    description: 'Review this agent’s reusable checklists and tracked to-dos.',
    title: 'To-dos',
  },
}

type AgentDetailTabsProps = {
  agent: AgentRecord
  // When provided, an "Edit" tab is prepended and selected first, so the agent
  // detail page leads with editing and keeps the read-only panels behind it.
  editSlot?: ReactNode
  onSelectAgent?: (agentId: string) => void
}

export const AgentDetailTabs = ({ agent, editSlot, onSelectAgent }: AgentDetailTabsProps) => {
  const assistantPanel = useDesignerAssistantPanel()
  const tabs = useMemo(
    () => (editSlot ? [{ label: 'Edit', value: 'edit' as Tab }, ...DETAIL_TABS] : DETAIL_TABS),
    [editSlot],
  )
  // Land on the first tab actually rendered, so the selection and the leading
  // tab can never disagree when the tab order changes.
  const tabValues = useMemo(() => tabs.map((item) => item.value), [tabs])
  // `agentTab`, not `tab`: this strip also renders inside the agent quick-view
  // sheet over a conversation, whose own sections already own `?tab=`. It is
  // validated against the tabs actually rendered, so `?agentTab=edit` on a
  // non-owner's view reads as the first detail tab rather than a blank panel.
  const [activeTab, setActiveTab] = useTabParam(
    'agentTab',
    tabValues,
    editSlot ? 'edit' : FIRST_DETAIL_TAB,
  )
  const [messagePage, setMessagePage] = useState(0)

  const { data: status } = useAgentStatus(agent.id)
  const { data: activity } = useAgentActivity(agent.id)
  const { data: childAgents = [] } = useAgentChildren(agent.id)
  // Fetch PAGE_SIZE + 1 to detect whether a next page exists
  const { data: rawMessages = [] } = useAgentMessages(
    agent.id,
    PAGE_SIZE + 1,
    messagePage * PAGE_SIZE,
  )

  const toolEntries = useMemo(() => {
    if (!activity) return []
    return activity.recentToolCalls.length > 0
      ? activity.recentToolCalls
      : activity.currentRun?.toolCalls ?? []
  }, [activity])

  const hasNextPage = rawMessages.length > PAGE_SIZE
  const messages = rawMessages.slice(0, PAGE_SIZE)

  const handleTabChange = (tab: Tab) => {
    setActiveTab(tab)
    setMessagePage(0)
  }

  useEffect(() => {
    assistantPanel?.setPageContext(pageContextForTab[activeTab])
  }, [activeTab, assistantPanel])

  return (
    <div className="flex h-full flex-col">
      <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex-shrink-0 border-b border-[color:var(--sep)] px-4 py-2">
            <TabBar
              ariaLabel="Agent sections"
              fullWidth
              items={tabs}
              onChange={handleTabChange}
              value={activeTab}
            />
          </div>

          {/* Kept mounted (hidden when inactive) so switching tabs never
              discards in-progress edits or the design-assistant conversation. */}
          {editSlot ? (
            <div className={activeTab === 'edit' ? 'min-h-0 flex-1' : 'hidden'}>
              {editSlot}
            </div>
          ) : null}

          <div
            className={
              activeTab === 'edit'
                ? 'hidden'
                : activeTab === 'documents'
                  ? 'min-h-0 flex-1'
                  : 'flex-1 overflow-y-auto px-6 py-5'
            }
          >
        {activeTab === 'activity' && (
          <div className="grid gap-6">
            <section className="admin-card p-4">
              <SectionLabel>Current activity</SectionLabel>
              {status?.currentToolName || activity?.currentRun ? (
                <div className="mt-3 text-sm leading-6 text-[color:var(--tx2)]">
                  {status?.currentToolName
                    ? `${agent.name} is running ${status.currentToolName}.`
                    : `Run ${activity?.currentRun?.runId ?? agent.currentRunId ?? 'pending'} is active.`}
                </div>
              ) : (
                <EmptyState>This agent is currently idle.</EmptyState>
              )}
            </section>
            <AgentTriggerPanel agent={agent} />
            <ToolExecutionLog entries={toolEntries} />
            <AgentThoughtStream />
          </div>
        )}

        {activeTab === 'sub-agents' && (
          <SubAgentTree
            onSelect={onSelectAgent ?? (() => undefined)}
            selectedAgentId={agent.id}
            subAgents={childAgents}
          />
        )}

        {activeTab === 'tools' && (
          <div className="grid gap-6">
            <AgentAvailableTools agent={agent} />
            <AgentBrowserPanel agent={agent} />
          </div>
        )}

        {activeTab === 'to-dos' && <AgentTodosTab agent={agent} />}

            {activeTab === 'messages' && (
          <div className="grid gap-4">
            <AgentMessagePreview messages={messages} />
            {/* No total to name: the count is never fetched, only whether one
                more row exists. So the strip hides when neither direction
                leads anywhere — the only "single page" this side can see. */}
            <PaginationFooter
              canNext={hasNextPage}
              canPrevious={messagePage > 0}
              className="pt-4"
              hideWhenSinglePage
              label={`Page ${messagePage + 1}`}
              onPageChange={setMessagePage}
              page={messagePage}
            />
          </div>
            )}
            {activeTab === 'documents' && <AgentDocumentsTab agent={agent} />}
            {activeTab === 'email' && (
              <AgentEmailSection agentId={agent.id} canManage={Boolean(editSlot)} />
            )}
          </div>
      </div>
    </div>
  )
}
