import { useEffect, useLayoutEffect, useState, type RefObject } from 'react'
import { Link } from 'react-router-dom'
import { faArrowRightFromBracket, faGear } from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import type { MeAuth, MeUser } from '@nessie/schemas'
import { UserAvatar } from '../../components/primitives/UserAvatar'
import { PresenceControl } from './user-menu/PresenceControl'
import { StatusSection } from './user-menu/StatusSection'

// Friendly one-line description of how the user signs in.
const providerLabel = (auth: MeAuth): string => {
  if (auth.providerType === 'local-bootstrap' || auth.providerId === 'local') {
    return 'Email & password'
  }
  const name = auth.providerId.charAt(0).toUpperCase() + auth.providerId.slice(1)
  return `${name} account`
}

type MenuPosition = { left: number; bottom: number }

type UserMenuPopoverProps = {
  anchorRef: RefObject<HTMLElement | null>
  user: MeUser
  auth: MeAuth
  token: string | null
  onClose: () => void
  onLogout: () => void
}

const rowClassName = [
  'flex w-full items-center justify-between gap-3 rounded-lg px-2.5 py-2 text-left',
  'text-sm text-[color:var(--tx)] transition-colors hover:bg-[color:var(--overlay-weak)]',
].join(' ')

// Avatar menu: anchored to the rail avatar, showing the user's identity and the
// account/log-out actions. Rendered fixed so the rail's `overflow-hidden` does not
// clip it; a transparent full-screen scrim catches outside clicks.
export const UserMenuPopover = ({
  anchorRef,
  user,
  auth,
  token,
  onClose,
  onLogout,
}: UserMenuPopoverProps) => {
  const [position, setPosition] = useState<MenuPosition | null>(null)

  useLayoutEffect(() => {
    const anchor = anchorRef.current
    if (!anchor) return
    const rect = anchor.getBoundingClientRect()
    setPosition({ left: rect.right + 8, bottom: window.innerHeight - rect.bottom })
  }, [anchorRef])

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [onClose])

  if (!position) return null

  return (
    <>
      <div className="fixed inset-0 z-[60]" onClick={onClose} />
      <div
        className={[
          'fixed z-[61] w-[252px] overflow-hidden rounded-xl border',
          'border-[color:var(--sep)] bg-[color:var(--panel)] p-1.5',
          'shadow-[0_16px_48px_var(--scrim-strong)]',
        ].join(' ')}
        style={{ left: position.left, bottom: position.bottom }}
      >
        <div className="flex items-center gap-3 px-2 py-2">
          <UserAvatar
            avatarAttachmentId={user.avatarAttachmentId}
            avatarUrl={user.avatarUrl}
            displayName={user.displayName}
            gravatarUrl={user.gravatarUrl}
            ringColor="var(--panel)"
            size={40}
            token={token}
            userId={user.id}
          />
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-[color:var(--tx)]">
              {user.displayName}
            </div>
            <div className="truncate text-xs text-[color:var(--tx3)]">{user.email}</div>
          </div>
        </div>

        <div className="my-1 h-px bg-[color:var(--sep)]" />

        <PresenceControl />

        <div className="my-1 h-px bg-[color:var(--sep)]" />

        <StatusSection onClose={onClose} />

        <div className="my-1 h-px bg-[color:var(--sep)]" />

        <div className="px-2 py-1 text-xs text-[color:var(--tx3)]">{providerLabel(auth)}</div>

        <div className="my-1 h-px bg-[color:var(--sep)]" />

        <Link className={rowClassName} onClick={onClose} to="/settings/profile">
          <span>Account settings</span>
          <FontAwesomeIcon className="h-3.5 w-3.5 text-[color:var(--tx3)]" icon={faGear} />
        </Link>
        <button
          className={rowClassName}
          onClick={() => {
            onClose()
            onLogout()
          }}
          type="button"
        >
          <span>Log out</span>
          <FontAwesomeIcon
            className="h-3.5 w-3.5 text-[color:var(--tx3)]"
            icon={faArrowRightFromBracket}
          />
        </button>
      </div>
    </>
  )
}
