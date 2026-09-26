import { useNavigate } from 'react-router-dom'
import { Sheet } from '../../overlays/Sheet'
import type { AgentRecord } from '../../../lib/api-client'
import { useAgentEditViewer, useCanEditAgent } from './agent-edit-authority'
import { AgentIdentityBlock } from './AgentIdentityBlock'
import { agentOwnershipLabel } from './AgentOwnershipState'

type AgentDetailDrawerProps = {
  agent: AgentRecord | null
  onClose: () => void
}

/**
 * The quick look at an agent from wherever its name was pressed: who it is,
 * what state it is in, who manages it, and the way to its page. It carries no
 * sections of its own — everything about the agent lives on one page, so a
 * second copy of those tabs over a conversation is exactly the fork Rule zero
 * names (and it is what forced the page's tab into an `agentTab` parameter to
 * stay out of the conversation's own `tab`).
 */
export const AgentDetailDrawer = ({ agent, onClose }: AgentDetailDrawerProps) => {
  const navigate = useNavigate()
  const canEdit = useCanEditAgent(agent)
  const viewer = useAgentEditViewer()

  if (!agent) {
    return null
  }

  const openPage = () => {
    onClose()
    void navigate(`/admin/agents/${agent.id}`)
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
            <AgentIdentityBlock agent={agent} canEditAvatar={canEdit} />
          </div>
          <button className="admin-button admin-button-secondary" onClick={onClose} type="button">
            Close
          </button>
        </header>
        <div className="grid gap-4 px-6 py-5">
          <p className="text-sm text-[color:var(--tx2)]">
            {agent.systemManaged ? 'Provided by Nessie.' : `${agentOwnershipLabel(agent, viewer)}.`}
          </p>
          <div>
            <button className="admin-button admin-button-primary" onClick={openPage} type="button">
              Open agent page
            </button>
          </div>
        </div>
      </div>
    </Sheet>
  )
}
