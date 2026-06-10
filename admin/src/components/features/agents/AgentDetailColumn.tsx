import { useNavigate } from 'react-router-dom'
import { useAgentStatus } from '../../../facades/agents/hooks'
import type { AgentRecord } from '../../../lib/api-client'
import { StatusPill } from '../../primitives/StatusPill'
import { AgentCreateButton } from './AgentCreateButton'
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

export const AgentDetailColumn = ({
  agent,
  onBack,
  showBack,
}: AgentDetailColumnProps) => {
  const navigate = useNavigate()
  const { data: status } = useAgentStatus(agent.id)

  return (
    <div className="flex h-full flex-col bg-[color:var(--main)]">
      <div className="flex-shrink-0 border-b border-[color:var(--sep)] px-6 py-5">
        <div className="rounded-xl border border-[color:var(--sep)] bg-[var(--scrim-weak)] p-4">
          <div className="flex flex-wrap items-center gap-2">
            {showBack && onBack ? (
              <button
                className="flex h-7 w-7 items-center justify-center rounded text-[color:var(--tx2)] hover:bg-[var(--overlay)]"
                onClick={onBack}
                type="button"
              >
                <svg
                  className="h-4 w-4"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  viewBox="0 0 24 24"
                >
                  <path
                    d="M15 19l-7-7 7-7"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
            ) : null}
            <h2 className="min-w-0 flex-1 text-xl font-semibold text-[var(--tx)]">
              {agent.name}
            </h2>
            <AgentStatusDot status={agent.status} />
            <StatusPill tone={getStatusTone(agent.status)}>
              {agent.status}
            </StatusPill>
            <button
              className={[
                'flex h-7 w-7 items-center justify-center rounded',
                'text-[color:var(--tx2)] hover:bg-[var(--overlay)] hover:text-[var(--tx)]',
              ].join(' ')}
              onClick={() => void navigate(`/agents/designer/${agent.id}`)}
              title="Edit agent"
              type="button"
            >
              <svg
                className="h-4 w-4"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                viewBox="0 0 24 24"
              >
                <path
                  d="M12 20h9"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                <path
                  d="M16.5 3.5a2.121 2.121 0 113 3L7 19l-4 1 1-4L16.5 3.5z"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
            <AgentCreateButton
              className="flex-shrink-0"
              label="Create sub-agent"
              onClick={() => void navigate(`/agents/designer?parentId=${agent.id}`)}
            />
          </div>
          <div className="mt-2 text-sm text-[color:var(--tx2)]">{agent.role}</div>
          <div className="mt-1 text-xs uppercase tracking-[0.16em] text-[color:var(--tx3)]">
            {status?.currentToolName
              ? `Active tool: ${status.currentToolName}`
              : `Last activity ${new Date(agent.lastActivityAt).toLocaleString()}`}
          </div>
        </div>
      </div>

      <AgentDetailTabs key={agent.id} agent={agent} />
    </div>
  )
}
