import { useEffect, useRef } from 'react'
import { UserAvatar } from '../../components/primitives/UserAvatar'
import { useMyAvatarRevision } from '../../facades/auth/hooks'
import { isReactNativeWebView } from '../../lib/mobile-shell'
import { useAuthSession } from '../../providers/AuthSessionProvider'
import { useFocusMode } from '../../providers/FocusModeProvider'
import { useUserPresence } from '../../providers/PresenceProvider'
import { UserMenuPopover, type UserMenuPopoverPlacement } from './UserMenuPopover'
import { useTransientMenu } from './TransientMenuContext'

type UserMenuTriggerProps = {
  className?: string
  nativeShellBridge?: boolean
  onLogout: () => void
  placement?: UserMenuPopoverPlacement
  ringColor?: string
  showFeedbackLink?: boolean
}

type NativePhoneAccountWindow = Window & {
  ReactNativeWebView?: { postMessage: (data: string) => void }
  __nessieToggleAccountMenu?: () => void
}

// The desktop rail is the canonical account control. Other shells only change
// where its menu opens; its avatar, presence badges, and actions stay identical.
export const UserMenuTrigger = ({
  className,
  nativeShellBridge = false,
  onLogout,
  placement = 'rail',
  ringColor = 'var(--rail)',
  showFeedbackLink = false,
}: UserMenuTriggerProps) => {
  const { me, token } = useAuthSession()
  const { focusModeEnabled } = useFocusMode()
  // Follows a profile-photo change made on the settings page: the relay URL is
  // fixed, so without this the account button keeps the browser-cached image.
  const avatarRevision = useMyAvatarRevision()
  const selfPresence = useUserPresence(me?.user.id)
  const avatarButtonRef = useRef<HTMLButtonElement>(null)
  const { close, isOpen: menuOpen, toggle } = useTransientMenu()

  useEffect(() => {
    if (!nativeShellBridge || !isReactNativeWebView()) return undefined
    const target = window as NativePhoneAccountWindow
    target.__nessieToggleAccountMenu = toggle
    return () => {
      delete target.__nessieToggleAccountMenu
    }
  }, [nativeShellBridge, toggle])

  useEffect(() => {
    if (!nativeShellBridge || !isReactNativeWebView() || !me) return
    ;(window as NativePhoneAccountWindow).ReactNativeWebView?.postMessage(
      JSON.stringify({
        type: 'nessie:account',
        userAvatarUrl: me.user.avatarUrl ?? null,
        userName: me.user.displayName,
        userPresence: selfPresence?.state ?? 'offline',
        userFocusMode: focusModeEnabled,
        userStatusEmoji: selfPresence?.statusEmoji ?? null,
      }),
    )
  }, [focusModeEnabled, me, nativeShellBridge, selfPresence?.state, selfPresence?.statusEmoji])

  if (!me) return null

  return (
    <>
      <button
        aria-haspopup="menu"
        aria-label="Account menu"
        className={[
          'rounded-md transition-shadow',
          className ?? '',
          nativeShellBridge ? 'pointer-events-none fixed right-3 top-0 z-[69] h-px w-px opacity-0' : '',
          menuOpen
            ? 'ring-2 ring-[color:var(--accent)]'
            : 'hover:ring-2 hover:ring-[color:var(--overlay)]',
        ].join(' ')}
        onClick={toggle}
        ref={avatarButtonRef}
        title={me.user.displayName}
        type="button"
      >
        <UserAvatar
          avatarAttachmentId={me.user.avatarAttachmentId}
          avatarUrl={me.user.avatarUrl}
          displayName={me.user.displayName}
          focusPresence={focusModeEnabled}
          revision={avatarRevision}
          ringColor={ringColor}
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
          onClose={close}
          onLogout={onLogout}
          placement={placement}
          showFeedbackLink={showFeedbackLink}
          token={token}
          user={me.user}
        />
      ) : null}
    </>
  )
}
