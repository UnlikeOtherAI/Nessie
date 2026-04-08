import { useMemo } from 'react'
import {
  useAgentActivity,
  useAgentChildren,
  useAgentMessages,
  useAgentStatus,
} from '../../../facades/agents/hooks'
import type { AgentRecord } from '../../../lib/api-client'
import { EmptyState } from '../../shared/EmptyState'
import { StatusPill } from '../../primitives/StatusPill'
import { AgentThoughtStream } from './AgentThoughtStream'
import { AgentMessagePreview } from './AgentMessagePreview'
import { AgentStatusDot } from './AgentStatusDot'
import { SubAgentTree } from './SubAgentTree'
import { ToolExecutionLog } from './ToolExecutionLog'

type AgentDetailDrawerProps = {
  agent: AgentRecord | null
  onClose: () => void
  onSelectAgent: (agentId: string) => void
}

const getStatusTone = (status: AgentRecord['status']) => {
  if (status === 'error') {
    return 'danger'
  }

  if (status === 'waiting_approval') {
    return 'warning'
  }

  if (status === 'idle' || status === 'offline') {
    return 'muted'
  }

  return 'accent'
}

export const AgentDetailDrawer = ({
  agent,
  onClose,
  onSelectAgent,
}: AgentDetailDrawerProps) => {
  const agentId = agent?.id
  const { data: status } = useAgentStatus(agentId)
  const { data: activity } = useAgentActivity(agentId)
  const { data: childAgents = [] } = useAgentChildren(agentId)
  const { data: messages = [] } = useAgentMessages(agentId, 5)

  const toolEntries = useMemo(() => {
    if (!activity) {
      return []
    }

    return activity.recentToolCalls.length > 0
      ? activity.recentToolCalls
      : activity.currentRun?.toolCalls ?? []
  }, [activity])

  if (!agent) {
    return null
  }

  return (
    <>
      <button
        className="fixed inset-0 z-40 bg-[color:var(--ink)]/25"
        onClick={onClose}
        type="button"
      />
      <aside
        className={[
          'fixed inset-y-4 right-4 z-50 flex',
          'w-[min(560px,calc(100vw-2rem))] flex-col overflow-hidden',
          'rounded-[2rem] border border-[color:var(--line)]',
          'bg-[color:var(--panel-strong)]',
          'shadow-[0_32px_80px_rgba(31,26,23,0.18)]',
        ].join(' ')}
      >
        <header className="flex items-start justify-between gap-4 border-b border-[color:var(--line)] px-6 py-5">
          <div>
            <div className="flex items-center gap-3">
              <h2 className="text-2xl font-semibold">{agent.name}</h2>
              <AgentStatusDot status={agent.status} />
              <StatusPill tone={getStatusTone(agent.status)}>{agent.status}</StatusPill>
            </div>
            <div className="mt-2 text-sm text-[color:var(--muted)]">{agent.role}</div>
            <div className="mt-2 text-xs uppercase tracking-[0.16em] text-[color:var(--muted)]">
              {status?.currentToolName
                ? `Active tool: ${status.currentToolName}`
                : `Last activity ${new Date(agent.lastActivityAt).toLocaleString()}`}
            </div>
          </div>
          <button
            className="rounded-2xl border border-[color:var(--line)] bg-white px-4 py-2 text-sm font-medium"
            onClick={onClose}
            type="button"
          >
            Close
          </button>
        </header>
        <div className="flex-1 overflow-y-auto px-6 py-5">
          <div className="grid gap-6">
            <section className="rounded-[1.35rem] border border-[color:var(--line)] bg-white/75 p-4">
              <div className="text-xs font-semibold uppercase tracking-[0.2em] text-[color:var(--muted)]">
                Current activity
              </div>
              {status?.currentToolName || activity?.currentRun ? (
                <div className="mt-3 text-sm leading-6">
                  {status?.currentToolName
                    ? `${agent.name} is running ${status.currentToolName}.`
                    : `Run ${activity?.currentRun?.runId ?? agent.currentRunId ?? 'pending'} is active.`}
                </div>
              ) : (
                <EmptyState>This agent is currently idle.</EmptyState>
              )}
            </section>

            <SubAgentTree
              onSelect={onSelectAgent}
              selectedAgentId={agent.id}
              subAgents={childAgents}
            />
            <ToolExecutionLog entries={toolEntries} />
            <AgentThoughtStream />
            <AgentMessagePreview messages={messages} />
          </div>
        </div>
      </aside>
    </>
  )
}
