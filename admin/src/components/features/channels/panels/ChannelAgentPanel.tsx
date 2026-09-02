import { useNavigate } from 'react-router-dom'
import type {
  AgentRecord,
  ChannelRecord,
  PersonalAssistantPresenceParticipant,
  PersonalAssistantStateResponse,
} from '../../../../lib/api-client'
import { useCanEditAgent } from '../../agents/agent-edit-authority'
import { AgentAvailableTools } from '../../agents/AgentAvailableTools'
import { AgentIdentityBlock } from '../../agents/AgentIdentityBlock'
import { PersonalAssistantConfigBanner } from '../../personal-assistant/PersonalAssistantSurface'
import { SectionLabel } from '../../../primitives/SectionLabel'
import { ChannelPersonalAssistantPresences } from './ChannelPersonalAssistantPresences'

/**
 * The Agent section of a one-to-one conversation: who this agent is, every
 * tool it can reach, and the way in to change it.
 *
 * It deliberately replaces the Agents *list* here rather than sitting beside
 * it. A conversation with one agent has no roster to browse and no reason to
 * offer "create an agent" — that card belonged to a channel, and rendering it
 * on a DM was the shared-tab mistake this split undoes.
 *
 * Identity and tools are the same `AgentIdentityBlock` and
 * `AgentAvailableTools` that `/agents/:id` renders — the tools card therefore
 * carries the editor's switches and everyone else's read-only resolution
 * without a second implementation of either. Editing is a link to that page,
 * not a second designer.
 */
export const ChannelAgentPanel = ({
  activeChannel,
  agent,
  currentUserId,
  isPersonalAssistantConversation,
  personalAssistantChannel,
  personalAssistantPresences,
  personalAssistantState,
}: {
  activeChannel: ChannelRecord | null
  agent: AgentRecord
  currentUserId: string
  isPersonalAssistantConversation: boolean
  personalAssistantChannel: ChannelRecord | null
  personalAssistantPresences: PersonalAssistantPresenceParticipant[]
  personalAssistantState: PersonalAssistantStateResponse | null | undefined
}) => {
  const navigate = useNavigate()
  // Who may edit is the agent's ownership state, not the organization owner
  // role. A system-managed agent has no Designer to open either — the Personal
  // Assistant is configured through its own banner instead — which
  // `canEditAgent` already refuses.
  const canEdit = useCanEditAgent(agent)

  return (
    <div className="grid gap-4 p-5" data-testid="channel-agent-panel">
      <section className="admin-card p-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex min-w-0 items-start gap-3">
            <AgentIdentityBlock agent={agent} canEditAvatar={canEdit} />
          </div>
          <div className="flex flex-shrink-0 items-center gap-2">
            <button
              className="admin-button admin-button-secondary"
              onClick={() => void navigate(`/agents/${agent.id}`)}
              type="button"
            >
              Open agent
            </button>
            {canEdit ? (
              <button
                className="admin-button admin-button-primary"
                data-testid="channel-agent-edit"
                onClick={() => void navigate(`/agents/${agent.id}?agentTab=edit`)}
                type="button"
              >
                Edit agent
              </button>
            ) : null}
          </div>
        </div>

        {/* The Personal Assistant's banner below already carries its prompt
            preview and enabled tools, so repeating it here would be the same
            sentence twice on one screen. */}
        {isPersonalAssistantConversation ? null : (
          <div className="mt-4 border-t border-[color:var(--sep)] pt-4">
            <SectionLabel>Instructions</SectionLabel>
            <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-[color:var(--tx2)]">
              {agent.systemPrompt ?? 'No system prompt configured for this agent yet.'}
            </p>
          </div>
        )}
      </section>

      {isPersonalAssistantConversation ? (
        <PersonalAssistantConfigBanner
          agent={agent}
          channel={personalAssistantChannel}
          configSummary={personalAssistantState?.configSummary}
        />
      ) : null}

      {/* Deliberately not inside a card: the read-only resolution renders a
          Card per tool, and a card inside a card is the nesting the content
          system forbids. The label and the rule carry the grouping instead. */}
      <section className="grid gap-3">
        <div className="border-b border-[color:var(--sep)] pb-3">
          <SectionLabel>Tools</SectionLabel>
          <p className="mt-2 text-sm leading-6 text-[color:var(--tx2)]">
            Everything {agent.name} can reach in a run.
          </p>
        </div>
        <AgentAvailableTools agent={agent} editable={!agent.systemManaged} />
      </section>

      <ChannelPersonalAssistantPresences
        activeChannel={activeChannel}
        currentUserId={currentUserId}
        isPersonalAssistantConversation={isPersonalAssistantConversation}
        presences={personalAssistantPresences}
      />
    </div>
  )
}
