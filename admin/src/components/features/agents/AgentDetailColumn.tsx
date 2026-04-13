import { useNavigate } from 'react-router-dom'
import { useAgentStatus } from '../../../facades/agents/hooks'
import type { AgentRecord } from '../../../lib/api-client'
import { StatusPill } from '../../primitives/StatusPill'
import { AgentStatusDot } from './AgentStatusDot'
import { AgentDetailTabs } from './AgentDetailTabs'

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
            className={[
              'flex h-7 w-7 items-center justify-center rounded',
              'text-[color:var(--tx2)] hover:bg-white/10 hover:text-white',
            ].join(' ')}
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

      <AgentDetailTabs key={agent.id} agent={agent} />
    </div>
  )
}
