import { type RefObject } from 'react'
import { Link } from 'react-router-dom'
import { faArrowRightFromBracket, faCircleQuestion, faGear } from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import type { MeUser } from '@nessie/schemas'
import { Popover } from '../../components/overlays/Popover'
import { UserAvatar } from '../../components/primitives/UserAvatar'
import { DebugTokenButton } from '../../components/shared/DebugTokenButton'
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

const rowClassName = [
  'flex w-full items-center justify-between gap-3 rounded-lg px-2.5 py-2 text-left',
  'text-sm text-[color:var(--tx)] transition-colors hover:bg-[color:var(--overlay-weak)]',
].join(' ')

const panelClassName = [
  'w-[252px] overflow-hidden rounded-xl border',
  'border-[color:var(--sep)] bg-[color:var(--panel)] p-1.5',
  'shadow-[0_16px_48px_var(--scrim-strong)]',
].join(' ')

// Avatar menu: shared by the desktop rail and native-shell top bar. It keeps
// one set of account actions while opening away from the trigger in each shell
// — beside it on the rail, beneath its right edge in the top bar — through the
// one Popover primitive, so the flip and clamp are not its business.
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
      className={panelClassName}
      label="Account menu"
      onClose={onClose}
      open={open}
      placement={placement === 'topbar' ? 'bottom-end' : 'right'}
      role="menu"
    >
      <div className="flex items-center gap-3 px-2 py-2">
        <UserAvatar
          avatarAttachmentId={user.avatarAttachmentId}
          avatarUrl={user.avatarUrl}
          displayName={user.displayName}
          focusPresence={focusModeEnabled}
          ringColor="var(--panel)"
          showPresence
          showStatus
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

      <Link className={rowClassName} onClick={onClose} to="/feedback">
        <span>Feedback</span>
        <FontAwesomeIcon
          className="h-3.5 w-3.5 text-[color:var(--tx3)]"
          icon={faCircleQuestion}
        />
      </Link>
      <DebugTokenButton variant="menu" />

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
    </Popover>
  )
}
