import { useNavigate } from 'react-router-dom'
import { useAgents } from '../../../facades/agents/hooks'
import { useChannels } from '../../../facades/channels/hooks'
import { AgentAvatar } from '../../shared/AgentAvatar'
import { useAuthSession } from '../../../providers/AuthSessionProvider'
import { AgentStatusDot } from '../agents/AgentStatusDot'
import { SectionOverflowHint } from '../../shared/SectionOverflowHint'
import {
  DashboardSectionCard,
  SectionNotice,
  dashboardRowClass,
} from './DashboardSectionCard'
import {
  AGENT_ROW_CAP,
  agentStatusLabel,
  projectAgentRows,
  projectChannelRows,
} from './project-dashboard-data'

type ProjectAgentsSectionProps = {
  className?: string
  projectId: string
}

/**
 * The agents doing work in this project — the ones bound to its channels, with
 * their live status. An agent sitting in `error` or `waiting_approval` on a
 * project channel is exactly the exception this screen exists to surface, and
 * the row lands in the channel where it is stuck.
 */
export const ProjectAgentsSection = ({ className, projectId }: ProjectAgentsSectionProps) => {
  const navigate = useNavigate()
  const { data: channels } = useChannels()
  const { data: agents, isError, isPending } = useAgents()
  const { token } = useAuthSession()

  const projectChannels = projectChannelRows(channels ?? [], projectId)
  const rows = projectAgentRows(agents ?? [], projectChannels)
  const visible = rows.slice(0, AGENT_ROW_CAP)

  // Nothing bound, nothing to say: an empty card would be pure chrome.
  if (!isPending && !isError && rows.length === 0) return null

  return (
    <DashboardSectionCard
      className={className}
      count={isPending ? undefined : rows.length}
      title="Agents"
    >
      {isError ? <SectionNotice>Agents could not be loaded. Please refresh.</SectionNotice> : null}
      {visible.map(({ agent, channelId }) => (
        <button
          className={dashboardRowClass}
          key={agent.id}
          onClick={() => navigate(`/channels/${channelId}`)}
          title={`${agent.name} — ${agentStatusLabel(agent.status)}`}
          type="button"
        >
          <AgentAvatar agent={agent} size={28} token={token} />
          <span className="truncate text-sm text-[color:var(--tx)]">{agent.name}</span>
          <span className="ml-auto flex items-center gap-2">
            <span className="text-xs lowercase text-[color:var(--tx3)]">
              {agentStatusLabel(agent.status)}
            </span>
            <AgentStatusDot status={agent.status} />
          </span>
        </button>
      ))}
      <SectionOverflowHint count={rows.length - visible.length} noun="agent" />
    </DashboardSectionCard>
  )
}
