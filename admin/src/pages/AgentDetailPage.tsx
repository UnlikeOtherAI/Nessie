import { faChevronLeft } from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { useNavigate, useParams } from 'react-router-dom'
import { AgentAvatarQuickEdit } from '../components/features/agents/AgentAvatarQuickEdit'
import { AgentDetailTabs } from '../components/features/agents/AgentDetailTabs'
import { AgentStatusDot } from '../components/features/agents/AgentStatusDot'
import { PrivateAgentHomeLink } from '../components/features/agents/PrivateAgentHomeLink'
import { AgentDesignerContent } from './AgentDesignerPage'
import { useAgents, useAgentStatus } from '../facades/agents/hooks'
import type { AgentRecord } from '../lib/api-client'
import { PhoneNavigationButton } from '../layouts/admin-shell/PhoneNavigationButton'
import {
  LOCAL_BACK_PRIORITY,
  useLocalBack,
} from '../layouts/admin-shell/local-back/LocalBackContext'
import { usePhoneLayout } from '../lib/mobile-shell'
import { Pill } from '../components/primitives/Pill'
import { useIsOwner } from '../components/shared/OwnerGate'
import { DesignerAssistantPanelProvider } from '../components/features/agents/designer/DesignerAssistantPanelContext'
import { DesignerAssistantDrawer } from '../components/features/agents/designer/DesignerAssistantDrawer'

const getStatusTone = (status: AgentRecord['status']) => {
  if (status === 'error') return 'danger'
  if (status === 'waiting_approval' || status === 'waiting_input') return 'warning'
  if (status === 'idle' || status === 'offline') return 'muted'
  return 'accent'
}

// The agent detail surface. Tapping an agents-list row lands here. For an owner
// it opens on an inline **Edit** tab (the full Agent Designer, embedded), with
// the Activity / Sub-Agents / Tools / Messages panels behind it; a non-owner,
// who cannot edit, gets those read-only panels only. No floating drawer.
export const AgentDetailPage = () => {
  const navigate = useNavigate()
  const { agentId } = useParams<{ agentId?: string }>()
  const isOwner = useIsOwner()
  // `scope: 'all'` so a system/global agent (or a sub-agent) resolves too — the
  // same list the Agents page renders.
  const { data: agents = [], isPending } = useAgents({ scope: 'all' })
  const agent = agentId ? agents.find((candidate) => candidate.id === agentId) : undefined
  const { data: status } = useAgentStatus(agent?.id)

  const backToList = () => void navigate('/agents')

  // On a phone the shell's single leading doorway (PhoneNavigationButton) owns
  // Back — register the destination there so it returns to the agents list, and
  // render this page's own Back button only on wider layouts. Otherwise the two
  // stack up as a duplicate Back on mobile.
  const phoneLayout = usePhoneLayout()
  useLocalBack({
    active: phoneLayout,
    id: 'agent-detail',
    label: 'Agents',
    onBack: backToList,
    priority: LOCAL_BACK_PRIORITY.columnBase,
  })

  if (!agent) {
    return (
      <div className="flex h-full flex-col">
        <header className="flex items-center gap-3 px-6 pt-6 pb-4">
          <PhoneNavigationButton />
          {!phoneLayout ? (
            <button
              className="admin-button admin-button-secondary gap-1.5"
              onClick={backToList}
              type="button"
            >
              <FontAwesomeIcon className="h-3 w-3" icon={faChevronLeft} />
              Agents
            </button>
          ) : null}
        </header>
        <div className="flex flex-1 items-center justify-center text-sm text-[color:var(--tx3)]">
          {isPending ? 'Loading agent…' : 'This agent could not be found.'}
        </div>
      </div>
    )
  }

  return (
    <DesignerAssistantPanelProvider>
      <div className="flex h-full min-w-0 flex-col lg:flex-row">
        <div className="flex min-w-0 flex-1 flex-col">
          {/* Hand-rolled: AdminPageHeader can express neither the avatar in
              the leading lane (it hardcodes `leading` to PhoneNavigationButton
              and takes no `onBack` for the desktop-only Back) nor the
              three-line identity block — name + status dot + status Pill, role,
              current tool/last activity — under one title. */}
          <header className="flex items-start gap-3 px-6 pt-6 pb-4">
            <PhoneNavigationButton />
            {!phoneLayout ? (
              <button
                className="admin-button admin-button-secondary mt-1 gap-1.5"
                onClick={backToList}
                type="button"
              >
                <FontAwesomeIcon className="h-3 w-3" icon={faChevronLeft} />
                Agents
              </button>
            ) : null}
            <div className="flex min-w-0 flex-1 items-center gap-3">
              <AgentAvatarQuickEdit agent={agent} canEdit={isOwner} />
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <h1 className="truncate text-2xl font-semibold text-[color:var(--tx)]">
                    {agent.name}
                  </h1>
                  <AgentStatusDot status={agent.status} />
                  <Pill tone={getStatusTone(agent.status)}>{agent.status}</Pill>
                </div>
                <div className="truncate text-sm text-[color:var(--tx2)]">{agent.role}</div>
                <PrivateAgentHomeLink
                  agent={agent}
                  className="mt-2 inline-flex text-sm text-[color:var(--lnk)] hover:underline"
                />
                <div className="mt-0.5 text-xs uppercase tracking-[0.16em] text-[color:var(--tx3)]">
                  {status?.currentToolName
                    ? `Active tool: ${status.currentToolName}`
                    : `Last activity ${new Date(agent.lastActivityAt).toLocaleString()}`}
                </div>
              </div>
            </div>
          </header>

          <div className="min-h-0 flex-1 border-t border-[color:var(--sep)]">
            <AgentDetailTabs
              agent={agent}
              editSlot={
                isOwner ? (
                  <AgentDesignerContent agents={agents} editingAgent={agent} embedded />
                ) : undefined
              }
              key={agent.id}
              onSelectAgent={(nextAgentId) => void navigate(`/agents/${nextAgentId}`)}
            />
          </div>
        </div>
        {isOwner ? <DesignerAssistantDrawer /> : null}
      </div>
    </DesignerAssistantPanelProvider>
  )
}
