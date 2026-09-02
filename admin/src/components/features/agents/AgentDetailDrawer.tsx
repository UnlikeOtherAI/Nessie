import { useNavigate } from 'react-router-dom'
import { useAgentStatus } from '../../../facades/agents/hooks'
import { Sheet } from '../../overlays/Sheet'
import type { AgentRecord } from '../../../lib/api-client'
import { Pill } from '../../primitives/Pill'
import { useIsOwner } from '../../shared/OwnerGate'
import { AgentAvatarQuickEdit } from './AgentAvatarQuickEdit'
import { AgentStatusDot } from './AgentStatusDot'
import { AgentDetailTabs } from './AgentDetailTabs'

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
  const navigate = useNavigate()
  const isOwner = useIsOwner()
  const { data: status } = useAgentStatus(agent?.id)

  if (!agent) {
    return null
  }

  return (
    <Sheet onClose={onClose} open side="right" size="lg" title={`${agent.name} details`}>
      <div
        className={[
          'flex h-full w-full min-h-0 flex-col overflow-hidden',
          'rounded-2xl border border-[color:var(--sep)] bg-[color:var(--sb)]',
          'shadow-[0_32px_80px_var(--scrim-strong)]',
        ].join(' ')}
      >
        <header
          className={[
            'flex-shrink-0 flex items-start justify-between gap-4',
            'border-b border-[color:var(--sep)] px-6 py-5',
          ].join(' ')}
        >
          <div>
            <div className="flex items-center gap-3">
              <AgentAvatarQuickEdit agent={agent} canEdit={isOwner} />
              <h2 className="text-2xl font-semibold text-[var(--tx)]">{agent.name}</h2>
              <AgentStatusDot status={agent.status} />
              <Pill tone={getStatusTone(agent.status)}>{agent.status}</Pill>
            </div>
            <div className="mt-2 text-sm text-[color:var(--tx2)]">{agent.role}</div>
            <div className="mt-2 text-xs uppercase tracking-[0.16em] text-[color:var(--tx3)]">
              {status?.currentToolName
                ? `Active tool: ${status.currentToolName}`
                : `Last activity ${new Date(agent.lastActivityAt).toLocaleString()}`}
            </div>
          </div>
          <div className="flex gap-2">
            {isOwner ? (
              <button
                className="admin-button admin-button-secondary"
                onClick={() => void navigate(`/agents/designer/${agent.id}`)}
                type="button"
              >
                Edit details
              </button>
            ) : null}
            <button
              className="admin-button admin-button-secondary"
              onClick={onClose}
              type="button"
            >
              Close
            </button>
          </div>
        </header>

        <AgentDetailTabs key={agent.id} agent={agent} onSelectAgent={onSelectAgent} />
      </div>
    </Sheet>
  )
}
