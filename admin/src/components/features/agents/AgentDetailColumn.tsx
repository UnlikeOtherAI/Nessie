import { useNavigate } from 'react-router-dom'
import { useAgentStatus } from '../../../facades/agents/hooks'
import type { AgentRecord } from '../../../lib/api-client'
import { useAuthSession } from '../../../providers/AuthSessionProvider'
import { StatusPill } from '../../primitives/StatusPill'
import { AgentCreateButton } from './AgentCreateButton'
import { AgentAvatarQuickEdit } from './AgentAvatarQuickEdit'
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
  const { me } = useAuthSession()
  const { data: status } = useAgentStatus(agent.id)
  const isOwner = me?.user.roleIds.includes('owner') ?? false

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
            <AgentAvatarQuickEdit agent={agent} canEdit={isOwner} />
            <h2 className="min-w-0 flex-1 text-xl font-semibold text-[var(--tx)]">
              {agent.name}
            </h2>
            <AgentStatusDot status={agent.status} />
            <StatusPill tone={getStatusTone(agent.status)}>
              {agent.status}
            </StatusPill>
            {isOwner ? (
              <button
                className="admin-button admin-button-secondary"
                onClick={() => void navigate(`/agents/designer/${agent.id}`)}
                type="button"
              >
                Edit details
              </button>
            ) : null}
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
