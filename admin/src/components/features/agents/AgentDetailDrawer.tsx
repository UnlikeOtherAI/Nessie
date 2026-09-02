import { useNavigate } from 'react-router-dom'
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
    <>
      <button className="fixed inset-0 z-40 bg-[var(--scrim-strong)]" onClick={onClose} type="button" />
      <aside
        className={[
          'fixed inset-y-3 right-3 z-50 flex',
          'w-[min(620px,calc(100vw-1.5rem))] flex-col overflow-hidden',
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
      </aside>
    </>
  )
}
