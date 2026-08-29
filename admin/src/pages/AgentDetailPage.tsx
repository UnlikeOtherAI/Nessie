import { faChevronLeft } from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { useNavigate, useParams } from 'react-router-dom'
import { AgentAvatarQuickEdit } from '../components/features/agents/AgentAvatarQuickEdit'
import { AgentDetailTabs } from '../components/features/agents/AgentDetailTabs'
import { AgentStatusDot } from '../components/features/agents/AgentStatusDot'
import { useAgents, useAgentStatus } from '../facades/agents/hooks'
import type { AgentRecord } from '../lib/api-client'
import { PhoneNavigationButton } from '../layouts/admin-shell/PhoneNavigationButton'
import { StatusPill } from '../components/primitives/StatusPill'
import { useAuthSession } from '../providers/AuthSessionProvider'

const getStatusTone = (status: AgentRecord['status']) => {
  if (status === 'error') return 'danger'
  if (status === 'waiting_approval') return 'warning'
  if (status === 'idle' || status === 'offline') return 'muted'
  return 'accent'
}

// The agent detail surface. Tapping an agents-list row lands here — the same
// Activity / Sub-Agents / Tools / Messages tabs the old floating drawer showed,
// now rendered inline as a full page inside the Agents section (no drawer).
export const AgentDetailPage = () => {
  const navigate = useNavigate()
  const { agentId } = useParams<{ agentId?: string }>()
  const { me } = useAuthSession()
  const isOwner = me?.user.roleIds.includes('owner') ?? false
  // `scope: 'all'` so a system/global agent (or a sub-agent) resolves too — the
  // same list the Agents page renders.
  const { data: agents = [], isPending } = useAgents({ scope: 'all' })
  const agent = agentId ? agents.find((candidate) => candidate.id === agentId) : undefined
  const { data: status } = useAgentStatus(agent?.id)

  const backToList = () => void navigate('/agents')

  if (!agent) {
    return (
      <div className="flex h-full flex-col">
        <header className="flex items-center gap-3 px-6 pt-6 pb-4">
          <PhoneNavigationButton />
          <button
            className="admin-button admin-button-secondary gap-1.5"
            onClick={backToList}
            type="button"
          >
            <FontAwesomeIcon className="h-3 w-3" icon={faChevronLeft} />
            Agents
          </button>
        </header>
        <div className="flex flex-1 items-center justify-center text-sm text-[color:var(--tx3)]">
          {isPending ? 'Loading agent…' : 'This agent could not be found.'}
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-start gap-3 px-6 pt-6 pb-4">
        <PhoneNavigationButton />
        <button
          className="admin-button admin-button-secondary mt-1 gap-1.5"
          onClick={backToList}
          type="button"
        >
          <FontAwesomeIcon className="h-3 w-3" icon={faChevronLeft} />
          Agents
        </button>
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <AgentAvatarQuickEdit agent={agent} canEdit={isOwner} />
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="truncate text-2xl font-semibold text-[color:var(--tx)]">
                {agent.name}
              </h1>
              <AgentStatusDot status={agent.status} />
              <StatusPill tone={getStatusTone(agent.status)}>{agent.status}</StatusPill>
            </div>
            <div className="truncate text-sm text-[color:var(--tx2)]">{agent.role}</div>
            <div className="mt-0.5 text-xs uppercase tracking-[0.16em] text-[color:var(--tx3)]">
              {status?.currentToolName
                ? `Active tool: ${status.currentToolName}`
                : `Last activity ${new Date(agent.lastActivityAt).toLocaleString()}`}
            </div>
          </div>
        </div>
        {isOwner ? (
          <button
            className="admin-button admin-button-secondary"
            onClick={() => void navigate(`/agents/designer/${agent.id}`)}
            type="button"
          >
            Edit details
          </button>
        ) : null}
      </header>

      <div className="min-h-0 flex-1 border-t border-[color:var(--sep)]">
        <AgentDetailTabs
          agent={agent}
          key={agent.id}
          onSelectAgent={(nextAgentId) => void navigate(`/agents/${nextAgentId}`)}
        />
      </div>
    </div>
  )
}
