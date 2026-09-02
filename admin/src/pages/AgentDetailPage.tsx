import { faChevronLeft } from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { useNavigate, useParams } from 'react-router-dom'
import { AgentDetailTabs } from '../components/features/agents/AgentDetailTabs'
import { AgentIdentityBlock } from '../components/features/agents/AgentIdentityBlock'
import { PrivateAgentHomeLink } from '../components/features/agents/PrivateAgentHomeLink'
import { AgentDesignerContent } from './AgentDesignerPage'
import { useAgents } from '../facades/agents/hooks'
import { PhoneNavigationButton } from '../layouts/admin-shell/PhoneNavigationButton'
import {
  LOCAL_BACK_PRIORITY,
  useLocalBack,
} from '../layouts/admin-shell/local-back/LocalBackContext'
import { usePhoneLayout } from '../lib/mobile-shell'
import { QueryState } from '../components/shared/QueryState'
import { useIsOwner } from '../components/shared/OwnerGate'
import { DesignerAssistantPanelProvider } from '../components/features/agents/designer/DesignerAssistantPanelContext'
import { DesignerAssistantDrawer } from '../components/features/agents/designer/DesignerAssistantDrawer'

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
  const agentsQuery = useAgents({ scope: 'all' })
  const agents = agentsQuery.data ?? []
  const agent = agentId ? agents.find((candidate) => candidate.id === agentId) : undefined

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
        <QueryState
          className="flex flex-1 items-center justify-center"
          emptyLabel="This agent could not be found."
          errorLabel="Agents could not be loaded."
          isEmpty
          loadingLabel="Loading agent…"
          query={agentsQuery}
        >
          {() => null}
        </QueryState>
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
              <AgentIdentityBlock agent={agent} canEditAvatar={isOwner} headingLevel="h1">
                <PrivateAgentHomeLink
                  agent={agent}
                  className="mt-2 inline-flex text-sm text-[color:var(--lnk)] hover:underline"
                />
              </AgentIdentityBlock>
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
