import { useRef, useState } from 'react'
import { UserAvatar } from '../../components/primitives/UserAvatar'
import { useAuthSession } from '../../providers/AuthSessionProvider'
import { UserMenuPopover, type UserMenuPopoverPlacement } from './UserMenuPopover'

type UserMenuTriggerProps = {
  onLogout: () => void
  placement?: UserMenuPopoverPlacement
}

// The desktop rail is the canonical account control. Other shells only change
// where its menu opens; its avatar, presence badges, and actions stay identical.
export const UserMenuTrigger = ({
  onLogout,
  placement = 'rail',
}: UserMenuTriggerProps) => {
  const { me, token } = useAuthSession()
  const avatarButtonRef = useRef<HTMLButtonElement>(null)
  const [menuOpen, setMenuOpen] = useState(false)

  if (!me) return null

  return (
    <>
      <button
        aria-haspopup="menu"
        aria-label="Account menu"
        className={[
          'rounded-full transition-shadow',
          menuOpen
            ? 'ring-2 ring-[color:var(--accent)]'
            : 'hover:ring-2 hover:ring-[color:var(--overlay)]',
        ].join(' ')}
        onClick={() => setMenuOpen((open) => !open)}
        ref={avatarButtonRef}
        title={me.user.displayName}
        type="button"
      >
        <UserAvatar
          avatarAttachmentId={me.user.avatarAttachmentId}
          avatarUrl={me.user.avatarUrl}
          displayName={me.user.displayName}
          gravatarUrl={me.user.gravatarUrl}
          ringColor="var(--rail)"
          showPresence
          showStatus
          size={32}
          token={token}
          userId={me.user.id}
        />
      </button>
      {menuOpen ? (
        <UserMenuPopover
          anchorRef={avatarButtonRef}
          auth={me.auth}
          onClose={() => setMenuOpen(false)}
          onLogout={onLogout}
          placement={placement}
          token={token}
          user={me.user}
        />
      ) : null}
    </>
  )
}
