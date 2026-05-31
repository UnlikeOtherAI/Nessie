import type { UserRecord } from '../../../lib/api-client'
import { getInitials, pickGradient } from '../../../lib/avatar'
import { CloseIcon } from './icons'
import { actionBtnClass, rowClass } from './styles'

type CurrentUserRowProps = {
  user: UserRecord
  currentUserId: string
  removePending: boolean
  onRemove: (userId: string) => void
}

/** A user who is already a member of the channel. */
export const CurrentUserRow = ({
  user,
  currentUserId,
  removePending,
  onRemove,
}: CurrentUserRowProps) => (
  <div className={rowClass}>
    <div
      className={[
        'flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full',
        'text-xs font-semibold text-white',
      ].join(' ')}
      style={{ background: pickGradient(user.id) }}
    >
      {getInitials(user.displayName, '?')}
    </div>
    <div className="min-w-0 flex-1">
      <div className="truncate text-sm font-medium text-white">
        {user.displayName}
        {user.id === currentUserId && (
          <span className="ml-1.5 text-xs text-[color:var(--tx3)]">(you)</span>
        )}
      </div>
      <div className="truncate text-xs text-[color:var(--tx3)]">
        {user.email}
      </div>
    </div>
    <span
      className={[
        'rounded bg-white/6 px-1.5 py-0.5 text-[10px] uppercase',
        'tracking-[0.12em] text-[color:var(--tx3)]',
      ].join(' ')}
    >
      user
    </span>
    {user.id !== currentUserId && (
      <button
        className={`${actionBtnClass} text-[color:var(--tx3)] hover:bg-red-500/10 hover:text-red-400`}
        disabled={removePending}
        onClick={() => onRemove(user.id)}
        title="Remove from channel"
        type="button"
      >
        <CloseIcon className="h-3.5 w-3.5" />
      </button>
    )}
  </div>
)

type AvailableUserRowProps = {
  user: UserRecord
  addPending: boolean
  onAdd: (userId: string) => void
}

/** A user who can be added to the channel. */
export const AvailableUserRow = ({
  user,
  addPending,
  onAdd,
}: AvailableUserRowProps) => (
  <div className={rowClass}>
    <div
      className={[
        'flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full',
        'text-xs font-semibold text-white/60',
      ].join(' ')}
      style={{ background: pickGradient(user.id), opacity: 0.6 }}
    >
      {getInitials(user.displayName, '?')}
    </div>
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
        'hover:border-white/20 hover:text-white',
      ].join(' ')}
      disabled={addPending}
      onClick={() => onAdd(user.id)}
      type="button"
    >
      Add
    </button>
  </div>
)
