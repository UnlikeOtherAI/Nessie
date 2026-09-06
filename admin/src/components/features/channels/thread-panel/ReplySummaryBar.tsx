import { UserAvatar } from '../../../shared/UserAvatar'
import { AgentAvatar } from '../../../shared/AgentAvatar'
import { formatRelativeTime } from '../../workflows/presentation'
import type { ThreadParticipant } from './thread-replies'

const MAX_AVATARS = 5

interface ReplySummaryBarProps {
  lastReplyAt: string | null
  participantIds: string[]
  replyCount: number
  resolveParticipant: (participantId: string) => ThreadParticipant | null
  token: string | null
  onOpen: () => void
}

// Slack-style collapsed thread affordance (#233): rendered under a root
// message with replies — overlapping participant avatars, "N replies", and the
// last-reply timestamp. The whole bar is one click target opening the panel.
export const ReplySummaryBar = ({
  lastReplyAt,
  participantIds,
  replyCount,
  resolveParticipant,
  token,
  onOpen,
}: ReplySummaryBarProps) => {
  const participants = [...new Set(participantIds)]
    .map((id) => resolveParticipant(id))
    .filter((participant): participant is ThreadParticipant => participant !== null)
    .slice(0, MAX_AVATARS)
  const lastReplyLabel = lastReplyAt ? formatRelativeTime(lastReplyAt) : undefined

  return (
    <button
      className={[
        'mt-1 flex w-fit max-w-full items-center gap-2 rounded-lg px-2 py-1',
        'text-left transition-colors hover:bg-[color:var(--main-hover)]',
      ].join(' ')}
      onClick={(event) => {
        event.stopPropagation()
        onOpen()
      }}
      type="button"
    >
      {participants.length > 0 ? (
        <span className="flex flex-shrink-0 items-center">
          {participants.map((participant, index) => (
            <span
              className={index === 0 ? '' : '-ml-1.5'}
              key={
                participant.kind === 'user'
                  ? `user:${participant.displayName}:${index}`
                  : `agent:${participant.agent.id}`
              }
            >
              {participant.kind === 'user' ? (
                <UserAvatar
                  avatarAttachmentId={participant.avatarAttachmentId ?? undefined}
                  avatarUrl={participant.avatarUrl ?? undefined}
                  className="ring-2 ring-[color:var(--main)]"
                  displayName={participant.displayName}
                  size={20}
                  token={token}
                  userId={participant.userId}
                />
              ) : (
                <AgentAvatar
                  agent={participant.agent}
                  className="ring-2 ring-[color:var(--main)]"
                  size={20}
                  token={token}
                />
              )}
            </span>
          ))}
        </span>
      ) : null}
      <span className="flex-shrink-0 text-xs font-semibold text-[color:var(--lnk)]">
        {replyCount} {replyCount === 1 ? 'reply' : 'replies'}
      </span>
      {lastReplyLabel ? (
        <span className="truncate text-xs text-[color:var(--tx3)]">
          Last reply {lastReplyLabel}
        </span>
      ) : null}
    </button>
  )
}
