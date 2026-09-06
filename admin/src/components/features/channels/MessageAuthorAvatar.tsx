import { UserAvatar } from '../../shared/UserAvatar'
import { identityRingRadius } from '../../../lib/identity-shape'
import { AgentAvatar, type AgentAvatarSource } from '../../shared/AgentAvatar'

/** Every message avatar in the feed and the reply panel is this size. */
export const MESSAGE_AVATAR_SIZE = 36

type MessageAuthorAvatarProps = {
  agent?: AgentAvatarSource | null
  /** Lets the agent identity directory resolve a portrait the row lacks. */
  agentId?: string | null
  displayName: string
  isAgent: boolean
  /** Absent when the author is not openable (a deleted user, a system post). */
  onOpen?: (event: React.MouseEvent<HTMLButtonElement>) => void
  token: string | null
  user: { avatarAttachmentId?: string; avatarUrl?: string; userId?: string }
}

/**
 * The author picture on a message, wherever a message is rendered.
 *
 * It replaced a five-way branch that disagreed with itself: an agent's focus
 * ring was `rounded-lg` while a person's was `rounded-full`, so the same
 * keyboard focus drew two different shapes in one feed, and the assistant
 * branches each resolved their agent differently. Here the ring follows the
 * tile's own radius, and who the author *is* is the only thing that varies.
 */
export const MessageAuthorAvatar = ({
  agent,
  agentId,
  displayName,
  isAgent,
  onOpen,
  token,
  user,
}: MessageAuthorAvatarProps) => {
  const tile = isAgent ? (
    <AgentAvatar agent={agent} agentId={agentId} size={MESSAGE_AVATAR_SIZE} token={token} />
  ) : (
    <UserAvatar
      avatarAttachmentId={user.avatarAttachmentId}
      avatarUrl={user.avatarUrl}
      displayName={displayName}
      size={MESSAGE_AVATAR_SIZE}
      token={token}
      userId={user.userId}
    />
  )

  if (!onOpen) {
    return tile
  }

  return (
    <button
      aria-label={`Open ${displayName}`}
      className="outline-none transition focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
      onClick={onOpen}
      style={{ borderRadius: identityRingRadius(MESSAGE_AVATAR_SIZE, 1) }}
      type="button"
    >
      {tile}
    </button>
  )
}
