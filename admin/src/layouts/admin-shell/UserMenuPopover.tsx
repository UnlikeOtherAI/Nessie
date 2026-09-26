import { type RefObject } from 'react'
import { Link } from 'react-router-dom'
import { CircleHelp, LogOut, Settings } from 'lucide-react'
import type { MeUser } from '@nessie/schemas'
import { Popover } from '../../components/overlays/Popover'
import { UserAvatar } from '../../components/shared/UserAvatar'
import { useFocusMode } from '../../providers/FocusModeProvider'
import { PresenceControl } from './user-menu/PresenceControl'
import { StatusSection } from './user-menu/StatusSection'

export type UserMenuPopoverPlacement = 'rail' | 'topbar'

type UserMenuPopoverProps = {
  anchorRef: RefObject<HTMLElement | null>
  user: MeUser
  token: string | null
  open: boolean
  onClose: () => void
  onLogout: () => void
  placement?: UserMenuPopoverPlacement
}

// Avatar menu: shared by the desktop rail and native-shell top bar. It keeps
// one set of account actions while opening away from the trigger in each shell
// — beside it on the rail, beneath its right edge in the top bar — through the
// one Popover primitive, so the flip and clamp are not its business.
//
// Availability · Status · Your settings · Send feedback · Sign out, and
// nothing else: the computers a person paired are Your settings › Your
// computers, and the session debug is Admin › Advanced.
export const UserMenuPopover = ({
  anchorRef,
  user,
  token,
  open,
  onClose,
  onLogout,
  placement = 'rail',
}: UserMenuPopoverProps) => {
  const { focusModeEnabled } = useFocusMode()

  return (
    <Popover
      anchorRef={anchorRef}
      className="admin-account-menu"
      label="Account menu"
      onClose={onClose}
      open={open}
      placement={placement === 'topbar' ? 'bottom-end' : 'right'}
      role="menu"
    >
      <div className="flex items-center gap-2.5 px-2.5 py-2">
        <UserAvatar
          avatarAttachmentId={user.avatarAttachmentId}
          avatarUrl={user.avatarUrl}
          displayName={user.displayName}
          focusPresence={focusModeEnabled}
          ringColor="var(--panel)"
          showPresence
          showStatus
          size={32}
          token={token}
          userId={user.id}
        />
        <div className="min-w-0">
          <div className="truncate text-[13px] font-semibold text-[color:var(--tx)]">
            {user.displayName}
          </div>
          <div className="truncate text-[11px] text-[color:var(--tx3)]">{user.email}</div>
        </div>
      </div>

      <div className="admin-account-menu-divider" />

      <PresenceControl />

      <div className="admin-account-menu-divider" />

      <StatusSection onClose={onClose} />

      <div className="admin-account-menu-divider" />

      <Link className="admin-account-menu-row" onClick={onClose} to="/settings">
        <Settings aria-hidden="true" strokeWidth={2} />
        <span>Your settings</span>
      </Link>
      <Link className="admin-account-menu-row" onClick={onClose} to="/feedback">
        <CircleHelp aria-hidden="true" strokeWidth={2} />
        <span>Send feedback</span>
      </Link>

      <div className="admin-account-menu-divider" />

      <button
        className="admin-account-menu-row"
        onClick={() => {
          onClose()
          onLogout()
        }}
        type="button"
      >
        <LogOut aria-hidden="true" strokeWidth={2} />
        <span>Sign out</span>
      </button>
    </Popover>
  )
}
