import type {
  AgentRecord,
  ChannelRecord,
  PersonalAssistantPresenceParticipant,
  PersonalAssistantStateResponse,
} from '../../../lib/api-client'
import { ChannelAutomationsPanel } from './ChannelAutomationsPanel'
import { AgentTriggerPanel } from '../agents/AgentTriggerPanel'
import { AgentTodosTab } from '../agents/todos/AgentTodosTab'
import { ChannelAgentPanel } from './panels/ChannelAgentPanel'
import { ChannelAgentsPanel } from './panels/ChannelAgentsPanel'
import { ChannelFilesPanel } from './panels/ChannelFilesPanel'
import type { ChannelTab } from './channel-helpers'

interface ChannelTabPanelsProps {
  visibleActiveTab: ChannelTab
  isConversationSurface: boolean
  isPersonalAssistantConversation: boolean
  activeChannel: ChannelRecord | null
  boundAgents: AgentRecord[]
  // The single agent this conversation is with, when there is one. Its Agent,
  // To-dos and Routines sections all hang off it, and its presence is what
  // replaces the Agents roster with the Agent section.
  conversationAgent: AgentRecord | null
  personalAssistantChannel: ChannelRecord | null
  personalAssistantState: PersonalAssistantStateResponse | null | undefined
  personalAssistantPresences: PersonalAssistantPresenceParticipant[]
  currentUserId: string
  onCreateAgent: () => void
}

/**
 * Routes the conversation's non-message sections to their panel. Each section
 * is its own file: they answer different questions, and the agent-shaped ones
 * (Agent, To-dos, Routines) render the very components `/agents/:id` renders
 * rather than a channel-flavoured copy.
 */
export const ChannelTabPanels = ({
  visibleActiveTab,
  isConversationSurface,
  isPersonalAssistantConversation,
  activeChannel,
  boundAgents,
  conversationAgent,
  personalAssistantChannel,
  personalAssistantState,
  personalAssistantPresences,
  currentUserId,
  onCreateAgent,
}: ChannelTabPanelsProps) => (
  <>
    {visibleActiveTab === 'automations' && activeChannel ? (
      <ChannelAutomationsPanel channelId={activeChannel.id} />
    ) : null}

    {visibleActiveTab === 'files' ? (
      <ChannelFilesPanel
        activeChannel={activeChannel}
        isConversationSurface={isConversationSurface}
        isPersonalAssistantConversation={isPersonalAssistantConversation}
      />
    ) : null}

    {visibleActiveTab === 'agent' && conversationAgent ? (
      <ChannelAgentPanel
        activeChannel={activeChannel}
        agent={conversationAgent}
        currentUserId={currentUserId}
        isPersonalAssistantConversation={isPersonalAssistantConversation}
        personalAssistantChannel={personalAssistantChannel}
        personalAssistantPresences={personalAssistantPresences}
        personalAssistantState={personalAssistantState}
      />
    ) : null}

    {visibleActiveTab === 'to-dos' && conversationAgent ? (
      <div className="p-5" data-testid="channel-todos-panel">
        <AgentTodosTab agent={conversationAgent} />
      </div>
    ) : null}

    {visibleActiveTab === 'routines' && conversationAgent ? (
      <div className="p-5" data-testid="channel-routines-panel">
        <AgentTriggerPanel agent={conversationAgent} title="Routines" />
      </div>
    ) : null}

    {visibleActiveTab === 'agents' ? (
      <ChannelAgentsPanel
        activeChannel={activeChannel}
        boundAgents={boundAgents}
        currentUserId={currentUserId}
        isPersonalAssistantConversation={isPersonalAssistantConversation}
        personalAssistantPresences={personalAssistantPresences}
        onCreateAgent={onCreateAgent}
      />
    ) : null}
  </>
)
