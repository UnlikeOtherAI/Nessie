import { useNavigate } from 'react-router-dom'
import { useChannels } from '../../../facades/channels/hooks'
import { UnreadBadge } from '../../primitives/UnreadBadge'
import { SectionOverflowHint } from '../../shared/SectionOverflowHint'
import {
  DashboardSectionCard,
  SectionNotice,
  SectionSkeleton,
  dashboardRowClass,
} from './DashboardSectionCard'
import {
  CHANNEL_ROW_CAP,
  formatRelativeAge,
  projectChannelRows,
  showsChannelTeamName,
} from './project-dashboard-data'

type ProjectChannelsSectionProps = {
  className?: string
  projectId: string
}

/**
 * Where the conversation is. The channel list the shell already holds
 * (`staleTime: Infinity`, refreshed by realtime `message.new`), filtered to this
 * project and ordered unread-first — which is what makes this a router rather
 * than an activity feed.
 */
export const ProjectChannelsSection = ({ className, projectId }: ProjectChannelsSectionProps) => {
  const navigate = useNavigate()
  const { data: channels, isError, isPending } = useChannels()

  const rows = projectChannelRows(channels ?? [], projectId)
  const visible = rows.slice(0, CHANNEL_ROW_CAP)
  const showTeam = showsChannelTeamName(rows)

  return (
    <DashboardSectionCard
      className={className}
      count={isPending ? undefined : rows.length}
      title="Channels"
    >
      {isPending ? <SectionSkeleton /> : null}
      {isError ? <SectionNotice>Channels could not be loaded. Please refresh.</SectionNotice> : null}
      {!isPending && !isError && rows.length === 0 ? (
        <SectionNotice>
          No channels yet. Channels created under this project’s teams appear here.
        </SectionNotice>
      ) : null}
      {visible.map((channel) => {
        const age = formatRelativeAge(channel.lastMessageAt)
        return (
          <button
            className={dashboardRowClass}
            key={channel.id}
            onClick={() => navigate(`/channels/${channel.id}`)}
            type="button"
          >
            <span aria-hidden="true" className="w-4 text-center text-[color:var(--tx3)]">
              {channel.visibility === 'private' ? '🔒' : '#'}
            </span>
            <span
              className={[
                'truncate text-sm',
                channel.unreadCount > 0
                  ? 'font-bold text-[color:var(--tx)]'
                  : 'text-[color:var(--tx2)]',
              ].join(' ')}
            >
              {channel.label}
            </span>
            {showTeam ? (
              <span className="truncate text-xs text-[color:var(--tx3)]">{channel.teamName}</span>
            ) : null}
            <span className="ml-auto flex items-center gap-2">
              <UnreadBadge value={channel.unreadCount} />
              {age ? <span className="text-xs text-[color:var(--tx3)]">{age}</span> : null}
            </span>
          </button>
        )
      })}
      <SectionOverflowHint count={rows.length - visible.length} noun="channel" />
    </DashboardSectionCard>
  )
}
