import { useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  useAgentActivity,
  useAgentMessages,
  useAgentStatus,
} from '../../../facades/agents/hooks'
import type { AgentRecord } from '../../../lib/api-client'
import { EmptyState } from '../../shared/EmptyState'
import { StatusPill } from '../../primitives/StatusPill'
import { AgentStatusDot } from './AgentStatusDot'
import { AgentThoughtStream } from './AgentThoughtStream'
import { AgentMessagePreview } from './AgentMessagePreview'
import { ToolExecutionLog } from './ToolExecutionLog'

type AgentDetailColumnProps = {
  agent: AgentRecord
  onBack?: () => void
  showBack?: boolean
}

const getStatusTone = (status: AgentRecord['status']) => {
  if (status === 'error') return 'danger' as const
  if (status === 'waiting_approval') return 'warning' as const
  if (status === 'idle' || status === 'offline') return 'muted' as const
  return 'accent' as const
}

export const AgentDetailColumn = ({ agent, onBack, showBack }: AgentDetailColumnProps) => {
  const navigate = useNavigate()
  const { data: status } = useAgentStatus(agent.id)
  const { data: activity } = useAgentActivity(agent.id)
  const { data: messages = [] } = useAgentMessages(agent.id, 5)

  const toolEntries = useMemo(() => {
    if (!activity) return []
    return activity.recentToolCalls.length > 0
      ? activity.recentToolCalls
      : activity.currentRun?.toolCalls ?? []
  }, [activity])

  return (
    <div className="flex h-full flex-col bg-[color:var(--main)]">
      <div className="flex-shrink-0 border-b border-[color:var(--sep)] px-6 py-5">
        <div className="flex items-center gap-2">
          {showBack && onBack ? (
            <button
              className="flex h-7 w-7 items-center justify-center rounded text-[color:var(--tx2)] hover:bg-white/10"
              onClick={onBack}
              type="button"
            >
              <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path d="M15 19l-7-7 7-7" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          ) : null}
          <h2 className="flex-1 text-xl font-semibold text-white">{agent.name}</h2>
          <AgentStatusDot status={agent.status} />
          <StatusPill tone={getStatusTone(agent.status)}>{agent.status}</StatusPill>
          <button
            className="flex h-7 w-7 items-center justify-center rounded text-[color:var(--tx2)] hover:bg-white/10 hover:text-white"
            onClick={() => void navigate(`/agents/new?parentId=${agent.id}`)}
            title="Add child agent"
            type="button"
          >
            <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path d="M12 5v14M5 12h14" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>
        <div className="mt-2 text-sm text-[color:var(--tx2)]">{agent.role}</div>
        <div className="mt-1 text-xs uppercase tracking-[0.16em] text-[color:var(--tx3)]">
          {status?.currentToolName
            ? `Active tool: ${status.currentToolName}`
            : `Last activity ${new Date(agent.lastActivityAt).toLocaleString()}`}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-5">
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

          <ToolExecutionLog entries={toolEntries} />
          <AgentThoughtStream />
          <AgentMessagePreview messages={messages} />
        </div>
      </div>
    </div>
  )
}
