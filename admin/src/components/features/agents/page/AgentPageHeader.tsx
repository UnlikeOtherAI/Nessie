import type { ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { useCloneAgent, useStartAgentConversation } from '../../../../facades/agents/hooks'
import { formErrorMessage } from '../../../../facades/forms/form-errors'
import type { AgentRecord } from '../../../../lib/api-client'
import { useToasts } from '../../../../providers/ToastProvider'
import type { PageHeaderAction } from '../../../shared/ResponsivePageHeader'
import { ScreenHeader } from '../../../shared/ScreenHeader'
import { conversationPath } from '../conversations/AgentConversationList'
import { AgentAvatarQuickEdit, type AgentAvatarContext } from '../AgentAvatarQuickEdit'
import { AgentIdentityBlock } from '../AgentIdentityBlock'
import { agentOwnershipLabel } from '../AgentOwnershipState'
import { useAgentEditViewer } from '../agent-edit-authority'
import { privateAgentHomeChannelId } from '../PrivateAgentHomeLink'

type AgentPageHeaderProps = {
  agent: AgentRecord
  /** The unsaved name, role and instructions, so a generated picture fits the draft. */
  avatarContext?: AgentAvatarContext
  builtIn: boolean
  canEdit: boolean
  onBack: () => void
  tabs?: ReactNode
}

/**
 * The agent's identity, on every tab and every state of the page: its
 * picture, name, role and state in words, who manages it, Stop while a run is
 * live, and the way into a conversation with it. Somebody who does not manage
 * it is told whom to ask, and offered a copy of their own to change instead.
 */
export const AgentPageHeader = ({
  agent,
  avatarContext,
  builtIn,
  canEdit,
  onBack,
  tabs,
}: AgentPageHeaderProps) => {
  const navigate = useNavigate()
  const viewer = useAgentEditViewer()
  const { pushToast } = useToasts()
  const startConversation = useStartAgentConversation()
  const cloneAgent = useCloneAgent()
  const home = privateAgentHomeChannelId(agent)

  const openConversation = () => {
    if (home) {
      void navigate(`/channels/${home}`)
      return
    }
    startConversation.mutate({ agentId: agent.id }, {
      onError: (error) => pushToast({
        body: formErrorMessage(error, 'A conversation with this agent could not be opened.'),
        title: 'No conversation opened',
      }),
      onSuccess: (result) => void navigate(conversationPath(result.conversation)),
    })
  }
  const copyAgent = () => {
    cloneAgent.mutate(agent.id, {
      onError: (error) => pushToast({
        body: formErrorMessage(error, 'This agent could not be copied.'),
        title: 'No copy made',
      }),
      onSuccess: (copy) => void navigate(`/admin/agents/${copy.id}`),
    })
  }

  const actions: PageHeaderAction[] = [
    // A built-in agent is copied by nobody (the clone route refuses one), and a
    // private one is already its owner's alone.
    ...(!canEdit && !builtIn && agent.visibility !== 'private' ? [{
      disabled: cloneAgent.isPending,
      id: 'copy-agent',
      label: cloneAgent.isPending ? 'Copying…' : 'Create a copy you own',
      onSelect: copyAgent,
      priority: 60,
    } satisfies PageHeaderAction] : []),
    ...(!builtIn || agent.dmAddressable ? [{
      disabled: startConversation.isPending,
      id: 'open-conversation',
      label: 'Open conversation',
      onSelect: openConversation,
      primary: true,
      priority: 100,
    } satisfies PageHeaderAction] : []),
  ]

  const manager = builtIn ? 'Provided by Nessie' : agentOwnershipLabel(agent, viewer)

  return (
    <ScreenHeader
      actions={actions}
      backLabel="Back to Agents"
      leading={<AgentAvatarQuickEdit agent={agent} avatarContext={avatarContext} canEdit={canEdit} />}
      onBack={onBack}
      subtitle={
        // The identity block the drawer renders too, with its heading withheld
        // because this header owns the screen's single `h1`.
        <AgentIdentityBlock agent={agent} avatar={false} canEditAvatar={canEdit} headingLevel="none">
          <p className="mt-1 text-xs text-[color:var(--tx3)]" data-testid="agent-manager">
            {manager}
            {!canEdit && !builtIn ? ' · ask them to change it' : ''}
          </p>
        </AgentIdentityBlock>
      }
      tabs={tabs}
      title={agent.name}
    />
  )
}
