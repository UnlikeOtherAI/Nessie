import { type ReactNode, useEffect, useMemo, useState } from 'react'
import {
  useAgentActivity,
  useAgentChildren,
  useAgentMessages,
  useAgentStatus,
} from '../../../facades/agents/hooks'
import type { AgentRecord } from '../../../lib/api-client'
import { SectionLabel } from '../../primitives/SectionLabel'
import { TabBar, type TabBarItem } from '../../primitives/TabBar'
import { EmptyState } from '../../shared/EmptyState'
import { PaginationFooter } from '../../shared/PaginationFooter'
import { AgentAvailableTools } from './AgentAvailableTools'
import { AgentMessagePreview } from './AgentMessagePreview'
import { AgentThoughtStream } from './AgentThoughtStream'
import { AgentTriggerPanel } from './AgentTriggerPanel'
import { SubAgentTree } from './SubAgentTree'
import { ToolExecutionLog } from './ToolExecutionLog'
import {
  useDesignerAssistantPanel,
  type DesignerPageContext,
} from './designer/DesignerAssistantPanelContext'

type Tab = 'edit' | 'activity' | 'sub-agents' | 'tools' | 'messages'

const DETAIL_TABS: ReadonlyArray<TabBarItem<Tab>> = [
  { label: 'Activity', value: 'activity' },
  { label: 'Sub-Agents', value: 'sub-agents' },
  { label: 'Tools', value: 'tools' },
  { label: 'Messages', value: 'messages' },
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
  const [activeTab, setActiveTab] = useState<Tab>(editSlot ? 'edit' : 'activity')
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

        {activeTab === 'tools' && <AgentAvailableTools agent={agent} />}

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
          </div>
      </div>
    </div>
  )
}
