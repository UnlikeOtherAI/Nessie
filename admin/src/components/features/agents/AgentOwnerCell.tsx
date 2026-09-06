import type { AgentOwner } from '../../../lib/api-client'
import { UserAvatar } from '../../shared/UserAvatar'

type AgentOwnerCellProps = {
  owner?: AgentOwner | null
  /** A blueprint-managed agent has no steward at all — see below. */
  systemManaged?: boolean
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
 * A `systemManaged` agent is the one row where a null owner is NOT team-owned:
 * nobody edits a blueprint agent, organisation owners included, so reading it
 * as "Team-owned" would advertise an edit authority that does not exist.
 *
 * The avatar is `loading="lazy"` inside `UserAvatar`'s relay: each person costs
 * one upstream fetch and only the roster subject set is cached, not the image,
 * so a long agent list would otherwise fan out on first paint.
 */
export const AgentOwnerCell = ({
  owner,
  systemManaged,
  token,
}: AgentOwnerCellProps) => {
  if (systemManaged) {
    return (
      <span className="text-xs text-[color:var(--tx3)]">Provided by Nessie</span>
    )
  }

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
