import { useMemo, useState } from 'react'
import {
  useAgentActivity,
  useAgentChildren,
  useAgentMessages,
  useAgentStatus,
} from '../../../facades/agents/hooks'
import type { AgentRecord } from '../../../lib/api-client'
import { EmptyState } from '../../shared/EmptyState'
import { AgentAvailableTools } from './AgentAvailableTools'
import { AgentMessagePreview } from './AgentMessagePreview'
import { AgentThoughtStream } from './AgentThoughtStream'
import { AgentTriggerPanel } from './AgentTriggerPanel'
import { SubAgentTree } from './SubAgentTree'
import { ToolExecutionLog } from './ToolExecutionLog'

type Tab = 'activity' | 'sub-agents' | 'tools' | 'messages'

const TABS: { id: Tab; label: string }[] = [
  { id: 'activity', label: 'Current Activity' },
  { id: 'sub-agents', label: 'Sub Agent Tree' },
  { id: 'tools', label: 'Available Tools' },
  { id: 'messages', label: 'Last Messages' },
]

const PAGE_SIZE = 10

type AgentDetailTabsProps = {
  agent: AgentRecord
  onSelectAgent?: (agentId: string) => void
}

export const AgentDetailTabs = ({ agent, onSelectAgent }: AgentDetailTabsProps) => {
  const [activeTab, setActiveTab] = useState<Tab>('activity')
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

  return (
    <div className="flex h-full flex-col">
      <div className="flex-shrink-0 overflow-x-auto border-b border-[color:var(--sep)]">
        <div className="flex">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              className={[
                'flex-shrink-0 border-b-2 px-4 py-3 text-xs font-semibold',
                'uppercase tracking-[0.12em] transition-colors',
                activeTab === tab.id
                  ? 'border-[#7c3aed] text-white'
                  : 'border-transparent text-[color:var(--tx3)] hover:text-[color:var(--tx2)]',
              ].join(' ')}
              onClick={() => handleTabChange(tab.id)}
              type="button"
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-5">
        {activeTab === 'activity' && (
          <div className="grid gap-6">
            <section className="admin-card p-4">
              <div className="text-xs font-semibold uppercase tracking-[0.2em] text-[color:var(--tx3)]">
                Current activity
              </div>
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

        {activeTab === 'tools' && <AgentAvailableTools />}

        {activeTab === 'messages' && (
          <div className="grid gap-4">
            <AgentMessagePreview messages={messages} />
            {(messagePage > 0 || hasNextPage) && (
              <div className="flex items-center justify-between border-t border-[color:var(--sep)] pt-4">
                <button
                  className="admin-button admin-button-secondary"
                  disabled={messagePage === 0}
                  onClick={() => setMessagePage((p) => p - 1)}
                  type="button"
                >
                  Previous
                </button>
                <span className="text-xs text-[color:var(--tx3)]">Page {messagePage + 1}</span>
                <button
                  className="admin-button admin-button-secondary"
                  disabled={!hasNextPage}
                  onClick={() => setMessagePage((p) => p + 1)}
                  type="button"
                >
                  Next
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
