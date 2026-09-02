import { useNavigate } from 'react-router-dom'
import type {
  AgentRecord,
  ChannelRecord,
  PersonalAssistantPresenceParticipant,
} from '../../../../lib/api-client'
import { useAuthSession } from '../../../../providers/AuthSessionProvider'
import { AgentAvatar } from '../../../shared/AgentAvatar'
import { AgentStatusDot } from '../../agents/AgentStatusDot'
import { EmptyState } from '../../../shared/EmptyState'
import { SectionLabel } from '../../../primitives/SectionLabel'
import { ChannelPersonalAssistantPresences } from './ChannelPersonalAssistantPresences'

/**
 * The Agents section of a *channel*: who works in this room, and the way
 * through to each one. It is a roster and nothing more — the agent's own
 * detail (identity, tools, to-dos, routines, editing) belongs to
 * `/agents/:id`, which every row opens.
 */
const AgentRow = ({ agent, onOpen }: { agent: AgentRecord; onOpen: () => void }) => {
  const { token } = useAuthSession()

  return (
    <button
      className="admin-card flex w-full items-center gap-3 p-3 text-left transition-colors hover:bg-[color:var(--overlay-weak)]"
      data-testid="channel-agent-row"
      onClick={onOpen}
      type="button"
    >
      <AgentAvatar agent={agent} token={token} />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="truncate text-sm font-semibold text-[color:var(--tx)]">
            {agent.name}
          </span>
          <AgentStatusDot status={agent.status} />
        </span>
        <span className="mt-0.5 block truncate text-xs text-[color:var(--tx3)]">
          {agent.role}
        </span>
      </span>
      <svg
        aria-hidden="true"
        className="h-5 w-5 flex-shrink-0 text-[color:var(--tx3)]"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        viewBox="0 0 24 24"
      >
        <path d="m9 18 6-6-6-6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  )
}

export const ChannelAgentsPanel = ({
  activeChannel,
  boundAgents,
  currentUserId,
  isPersonalAssistantConversation,
  personalAssistantPresences,
  onCreateAgent,
}: {
  activeChannel: ChannelRecord | null
  boundAgents: AgentRecord[]
  currentUserId: string
  isPersonalAssistantConversation: boolean
  personalAssistantPresences: PersonalAssistantPresenceParticipant[]
  onCreateAgent: () => void
}) => {
  const navigate = useNavigate()

  return (
    <div className="grid gap-4 p-5" data-testid="channel-agents-panel">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <SectionLabel>Agents in this channel</SectionLabel>
          <p className="mt-1 text-sm leading-6 text-[color:var(--tx2)]">
            Open one to see its identity, tools, to-dos, and routines.
          </p>
        </div>
        <button
          className="admin-button admin-button-secondary"
          onClick={onCreateAgent}
          type="button"
        >
          Create agent
        </button>
      </div>

      {boundAgents.length > 0 ? (
        <div className="grid gap-2">
          {boundAgents.map((agent) => (
            <AgentRow
              agent={agent}
              key={agent.id}
              onOpen={() => void navigate(`/agents/${agent.id}`)}
            />
          ))}
        </div>
      ) : (
        <EmptyState>
          No agents are bound to this channel yet.
        </EmptyState>
      )}

      <ChannelPersonalAssistantPresences
        activeChannel={activeChannel}
        currentUserId={currentUserId}
        isPersonalAssistantConversation={isPersonalAssistantConversation}
        presences={personalAssistantPresences}
      />
    </div>
  )
}
