import type { AgentOwner } from '../../../lib/api-client'
import { UserAvatar } from '../../primitives/UserAvatar'

type AgentOwnerCellProps = {
  owner?: AgentOwner | null
  token: string | null
}

/**
 * Who stewards this agent — their "virtual employee".
 *
 * Team-owned is a real state, not a gap. Nothing recorded who created the
 * agents that existed before stewardship did, and "no steward" is now a
 * deliberate configuration rather than only missing history: a null owner means
 * every member entitled to the agent may edit it. So it reads "Team-owned"
 * rather than guessing a name. A deactivated steward is said plainly, because
 * an agent whose owner has left keeps running and somebody has to notice.
 *
 * The avatar is `loading="lazy"` inside `UserAvatar`'s relay: each person costs
 * one upstream fetch and only the roster subject set is cached, not the image,
 * so a long agent list would otherwise fan out on first paint.
 */
export const AgentOwnerCell = ({ owner, token }: AgentOwnerCellProps) => {
  if (!owner) {
    return (
      <span className="text-xs text-[color:var(--tx3)]">Team-owned</span>
    )
  }

  const name = owner.displayName ?? 'Unnamed member'
  const departed = owner.ownerState === 'deactivated'

  return (
    <span className="flex min-w-0 items-center gap-2">
      <UserAvatar
        avatarAttachmentId={owner.avatarAttachmentId ?? undefined}
        displayName={name}
        size={20}
        token={token}
        userId={owner.userId}
      />
      <span className="min-w-0">
        <span
          className={`block truncate text-xs ${
            departed
              ? 'text-[color:var(--tx3)] line-through'
              : 'text-[color:var(--tx2)]'
          }`}
        >
          {name}
        </span>
        {departed ? (
          <span className="block truncate text-[10px] text-[color:var(--tx3)]">
            No longer a member
          </span>
        ) : null}
      </span>
    </span>
  )
}
