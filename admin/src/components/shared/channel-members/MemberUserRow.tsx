import type { UserRecord } from '../../../lib/api-client'
import { AvatarBadges } from '../AvatarBadges'
import { Pill } from '../../primitives/Pill'
import { UserAvatar } from '../UserAvatar'
import { useAuthSession } from '../../../providers/AuthSessionProvider'
import { CloseIcon } from './icons'
import { actionBtnClass, rowClass } from './styles'

export type MemberUser = Pick<
  UserRecord,
  'id' | 'displayName' | 'email' | 'avatarAttachmentId' | 'avatarUrl'
>

type CurrentUserRowProps = {
  canRemove?: boolean
  removeLabel: string
  user: MemberUser
  currentUserId: string
  removePending: boolean
  onRemove: (userId: string) => void
}

/** A user who is already a member of the active channel or project. */
export const CurrentUserRow = ({
  canRemove = true,
  user,
  currentUserId,
  removeLabel,
  removePending,
  onRemove,
}: CurrentUserRowProps) => {
  const { token } = useAuthSession()
  return (
  <div className={rowClass}>
    <AvatarBadges ringColor="var(--panel)" size={32} userId={user.id}>
      <UserAvatar
        avatarAttachmentId={user.avatarAttachmentId ?? undefined}
        avatarUrl={user.avatarUrl ?? undefined}
        displayName={user.displayName}
        size={32}
        token={token}
        userId={user.id}
      />
    </AvatarBadges>
    <div className="min-w-0 flex-1">
      <div className="truncate text-sm font-medium text-[color:var(--tx)]">
        {user.displayName}
        {user.id === currentUserId && (
          <span className="ml-1.5 text-xs text-[color:var(--tx3)]">(you)</span>
        )}
      </div>
      <div className="truncate text-xs text-[color:var(--tx3)]">
        {user.email}
      </div>
    </div>
    <Pill radius="chip" size="sm">user</Pill>
    {canRemove && user.id !== currentUserId && (
      <button
        className={`${actionBtnClass} text-[color:var(--tx3)] hover:bg-[color:var(--danger-soft)] hover:text-[color:var(--danger-text)]`}
        disabled={removePending}
        onClick={() => onRemove(user.id)}
        title={removeLabel}
        type="button"
      >
        <CloseIcon className="h-3.5 w-3.5" />
      </button>
    )}
  </div>
  )
}

type AvailableUserRowProps = {
  user: MemberUser
  addPending: boolean
  onAdd: (userId: string) => void
}

/** A user who can be added to the active channel or project. */
export const AvailableUserRow = ({
  user,
  addPending,
  onAdd,
}: AvailableUserRowProps) => {
  const { token } = useAuthSession()
  return (
  <div className={rowClass}>
    <AvatarBadges ringColor="var(--panel)" size={32} userId={user.id}>
      <UserAvatar
        avatarAttachmentId={user.avatarAttachmentId ?? undefined}
        avatarUrl={user.avatarUrl ?? undefined}
        className="opacity-60"
        displayName={user.displayName}
        size={32}
        token={token}
        userId={user.id}
      />
    </AvatarBadges>
    <div className="min-w-0 flex-1">
      <div className="truncate text-sm text-[color:var(--tx2)]">
        {user.displayName}
      </div>
      <div className="truncate text-xs text-[color:var(--tx3)]">
        {user.email}
      </div>
    </div>
    <button
      className={[
        actionBtnClass,
        'border border-[color:var(--border-strong)] text-[color:var(--tx2)]',
        'hover:border-[color:var(--overlay-strong)] hover:text-[color:var(--tx)]',
      ].join(' ')}
      disabled={addPending}
      onClick={() => onAdd(user.id)}
      type="button"
    >
      Add
    </button>
  </div>
  )
}
