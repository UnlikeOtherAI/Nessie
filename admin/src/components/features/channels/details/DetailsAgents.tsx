import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useBindAgent, useCloneAgent, useUnbindAgent } from '../../../../facades/agents/hooks'
import type {
  AgentRecord,
  ChannelRecord,
  PersonalAssistantPresenceParticipant,
} from '../../../../lib/api-client'
import { AvailableAgentRow, CurrentAgentRow } from '../../../shared/channel-members/MemberAgentRow'
import { sectionHeadingClass } from '../../../shared/channel-members/styles'
import { FormError } from '../../../shared/FormActions'
import { Input } from '../../../shared/FormControls'
import { ChannelPersonalAssistantPresences } from '../panels/ChannelPersonalAssistantPresences'

const matches = (agent: AgentRecord, query: string): boolean => {
  const needle = query.trim().toLocaleLowerCase()
  return !needle || `${agent.name} ${agent.role}`.toLocaleLowerCase().includes(needle)
}

type DetailsAgentsProps = {
  /** Every agent that may be placed in a channel, global ones included. */
  agents: AgentRecord[]
  boundAgents: AgentRecord[]
  channel: ChannelRecord
  currentUserId: string
  personalAssistantPresences: PersonalAssistantPresenceParticipant[]
}

/**
 * Details › Agents: which agents work in this room, placing and removing them,
 * and the Personal Assistant presences. Placing is `viewerCanManageAgents` —
 * organisation owner or admin standing, and not membership: an administrator
 * outside the room may place an agent in it without being able to speak there
 * (docs/standards/team-model.md, "Management is not participation"). Somebody
 * without that standing sees the same rows with Add and Remove disabled and
 * is told who can use them. Viewing an agent opens its page.
 */
export const DetailsAgents = ({
  agents,
  boundAgents,
  channel,
  currentUserId,
  personalAssistantPresences,
}: DetailsAgentsProps) => {
  const navigate = useNavigate()
  const bindAgent = useBindAgent()
  const unbindAgent = useUnbindAgent()
  const cloneAgent = useCloneAgent()
  const [search, setSearch] = useState('')
  const canPlace = channel.viewerCanManageAgents
  const boundIds = useMemo(() => new Set(boundAgents.map((agent) => agent.id)), [boundAgents])
  const placed = boundAgents.filter((agent) => matches(agent, search))
  const available = agents.filter((agent) => !boundIds.has(agent.id) && matches(agent, search))
  const refusal = bindAgent.error ?? unbindAgent.error ?? cloneAgent.error

  return (
    <div className="grid gap-3">
      {!canPlace ? (
        <p className="text-sm text-[color:var(--tx3)]">
          Only an organisation owner or admin can add or remove agents here.
        </p>
      ) : null}
      <Input
        aria-label="Search agents"
        onChange={(event) => setSearch(event.target.value)}
        placeholder="Search agents"
        value={search}
      />
      <FormError>{refusal instanceof Error ? refusal.message : undefined}</FormError>

      <div className="grid gap-0.5">
        <div className={sectionHeadingClass}>In this channel</div>
        {placed.map((agent) => (
          <CurrentAgentRow
            agent={agent}
            canUnbind={canPlace}
            channelId={channel.id}
            clonePending={cloneAgent.isPending}
            key={agent.id}
            onClone={(agentId) => cloneAgent.mutate(agentId)}
            onUnbind={(agentId, channelId) => unbindAgent.mutate({ agentId, channelId })}
            onView={(agentId) => void navigate(`/admin/agents/${agentId}`)}
            unbindPending={unbindAgent.isPending}
          />
        ))}
        {placed.length === 0 ? (
          <p className="px-3 py-3 text-sm text-[color:var(--tx3)]">
            {search ? 'No agent in this channel matches that search.' : 'No agents work in this channel yet.'}
          </p>
        ) : null}
      </div>

      {available.length > 0 ? (
        <div className="grid gap-0.5 border-t border-[color:var(--sep)] pt-3">
          <div className={sectionHeadingClass}>Add to this channel</div>
          {available.map((agent) => (
            <AvailableAgentRow
              agent={agent}
              bindPending={bindAgent.isPending}
              canBind={canPlace}
              channelId={channel.id}
              clonePending={cloneAgent.isPending}
              key={agent.id}
              onBind={(agentId, channelId) => bindAgent.mutate({ agentId, channelId })}
              onClone={(agentId) => cloneAgent.mutate(agentId)}
            />
          ))}
        </div>
      ) : null}

      <ChannelPersonalAssistantPresences
        activeChannel={channel}
        currentUserId={currentUserId}
        isPersonalAssistantConversation={false}
        presences={personalAssistantPresences}
      />
    </div>
  )
}
