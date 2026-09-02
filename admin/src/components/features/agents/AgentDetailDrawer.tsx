import { useNavigate } from 'react-router-dom'
import { Sheet } from '../../overlays/Sheet'
import type { AgentRecord } from '../../../lib/api-client'
import { useIsOwner } from '../../shared/OwnerGate'
import { AgentIdentityBlock } from './AgentIdentityBlock'
import { AgentDetailTabs } from './AgentDetailTabs'

type AgentDetailDrawerProps = {
  agent: AgentRecord | null
  onClose: () => void
  onSelectAgent: (agentId: string) => void
}

export const AgentDetailDrawer = ({
  agent,
  onClose,
  onSelectAgent,
}: AgentDetailDrawerProps) => {
  const navigate = useNavigate()
  const isOwner = useIsOwner()

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
          <div className="flex items-center gap-3">
            <AgentIdentityBlock agent={agent} canEditAvatar={isOwner} />
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
