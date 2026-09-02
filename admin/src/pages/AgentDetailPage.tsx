import { useNavigate, useParams } from 'react-router-dom'
import { AgentAvatarQuickEdit } from '../components/features/agents/AgentAvatarQuickEdit'
import { AgentDetailTabs } from '../components/features/agents/AgentDetailTabs'
import { SystemAgentConfigPanel } from '../components/features/agents/SystemAgentConfigPanel'
import { AgentIdentityBlock } from '../components/features/agents/AgentIdentityBlock'
import { AgentOwnershipState } from '../components/features/agents/AgentOwnershipState'
import { PrivateAgentHomeLink } from '../components/features/agents/PrivateAgentHomeLink'
import { AgentDesignerContent } from './AgentDesignerPage'
import { useAgents } from '../facades/agents/hooks'
import { useCanEditAgent } from '../components/features/agents/agent-edit-authority'
import { QueryState } from '../components/shared/QueryState'
import { ScreenHeader } from '../components/shared/ScreenHeader'
import { DesignerAssistantPanelProvider } from '../components/features/agents/designer/DesignerAssistantPanelContext'
import { DesignerAssistantDrawer } from '../components/features/agents/designer/DesignerAssistantDrawer'

// The agent detail surface. Tapping an agents-list row lands here. For someone
// who may edit this agent it opens on an inline **Edit** tab (the full Agent
// Designer, embedded), with the Activity / Sub-Agents / Tools / Messages panels
// behind it; everybody else gets those read-only panels only. No floating
// drawer.
//
// "May edit" is the agent's ownership state, not the organization owner role
// this page used to ask for: the owner of a private or person-owned agent, any
// entitled member of a team-owned one, plus organization owners on workspace
// agents. See `agent-edit-authority.ts`.
export const AgentDetailPage = () => {
  const navigate = useNavigate()
  const { agentId } = useParams<{ agentId?: string }>()
  // `scope: 'all'` so a system/global agent (or a sub-agent) resolves too — the
  // same list the Agents page renders.
  const agentsQuery = useAgents({ scope: 'all' })
  const agents = agentsQuery.data ?? []
  const agent = agentId ? agents.find((candidate) => candidate.id === agentId) : undefined
  const canEdit = useCanEditAgent(agent)

  const backToList = () => void navigate('/agents')

  // `/agents/:id` is a real depth-2 route whose parent is Agents (the surface
  // registry, docs/navigation/overview.md §4.1), so the shared Back already returns to
  // the list — this page registers no owner of its own, which used to outrank
  // the Knowledge stages inside its Documents tab and leave the agent instead
  // of unwinding the open document. Wider layouts keep their own Back button
  // beside the title, which `ScreenHeader` renders from `onBack` because the
  // registry says this screen has a parent.

  if (!agent) {
    // The header is rendered here too: loading, failure and not-found are
    // states of this screen, and a phone with no header has no Back at all.
    return (
      <div className="flex h-full flex-col">
        <ScreenHeader backLabel="Back to Agents" onBack={backToList} title="Agent" />
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
          {/* The identity block the hero used to carry — status dot, status
              pill, role, home link, current tool — is the header's subtitle
              slot, and the avatar its leading slot. It is the one
              `AgentIdentityBlock` the drawer renders too, with its heading
              withheld because `ScreenHeader` owns the screen's single `h1`. */}
          <ScreenHeader
            backLabel="Back to Agents"
            leading={<AgentAvatarQuickEdit agent={agent} canEdit={canEdit} />}
            onBack={backToList}
            subtitle={
              <AgentIdentityBlock
                agent={agent}
                avatar={false}
                canEditAvatar={canEdit}
                headingLevel="none"
              >
                <AgentOwnershipState agent={agent} />
                <PrivateAgentHomeLink
                  agent={agent}
                  className="mt-2 inline-flex text-sm text-[color:var(--lnk)] hover:underline"
                />
              </AgentIdentityBlock>
            }
            title={agent.name}
          />

          {/* A Nessie-managed agent (the Personal Assistant, the Agent
              Designer) gets the read-only configuration view instead of the
              tabs: `isAgentAccessibleToActor` hard-codes `systemManaged:
              false`, so status, activity, messages and sub-agents all 404 on
              one, and mounting them made "not editable" read as "broken". Its
              activity genuinely stays closed — a global agent works in every
              member's private DM. */}
          <div className="min-h-0 flex-1 border-t border-[color:var(--sep)]">
            {agent.systemManaged ? (
              <SystemAgentConfigPanel agentId={agent.id} />
            ) : (
            <AgentDetailTabs
              agent={agent}
              editSlot={
                canEdit ? (
                  <AgentDesignerContent agents={agents} editingAgent={agent} embedded />
                ) : undefined
              }
              key={agent.id}
              onSelectAgent={(nextAgentId) => void navigate(`/agents/${nextAgentId}`)}
            />
            )}
          </div>
        </div>
        {canEdit ? <DesignerAssistantDrawer /> : null}
      </div>
    </DesignerAssistantPanelProvider>
  )
}
