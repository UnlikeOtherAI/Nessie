import { useEffect, useRef, useState } from 'react'
import { UserAvatar } from '../../components/primitives/UserAvatar'
import { isReactNativeWebView } from '../../lib/mobile-shell'
import { useAuthSession } from '../../providers/AuthSessionProvider'
import { useUserPresence } from '../../providers/PresenceProvider'
import { UserMenuPopover, type UserMenuPopoverPlacement } from './UserMenuPopover'

type UserMenuTriggerProps = {
  nativeShellBridge?: boolean
  onLogout: () => void
  placement?: UserMenuPopoverPlacement
}

type NativePhoneAccountWindow = Window & {
  ReactNativeWebView?: { postMessage: (data: string) => void }
  __nessieToggleAccountMenu?: () => void
}

// The desktop rail is the canonical account control. Other shells only change
// where its menu opens; its avatar, presence badges, and actions stay identical.
export const UserMenuTrigger = ({
  nativeShellBridge = false,
  onLogout,
  placement = 'rail',
}: UserMenuTriggerProps) => {
  const { me, token } = useAuthSession()
  const selfPresence = useUserPresence(me?.user.id)
  const avatarButtonRef = useRef<HTMLButtonElement>(null)
  const [menuOpen, setMenuOpen] = useState(false)

  useEffect(() => {
    if (!nativeShellBridge || !isReactNativeWebView()) return undefined
    const target = window as NativePhoneAccountWindow
    target.__nessieToggleAccountMenu = () => setMenuOpen((open) => !open)
    return () => {
      delete target.__nessieToggleAccountMenu
    }
  }, [nativeShellBridge])

  useEffect(() => {
    if (!nativeShellBridge || !isReactNativeWebView() || !me) return
    ;(window as NativePhoneAccountWindow).ReactNativeWebView?.postMessage(
      JSON.stringify({
        type: 'nessie:account',
        userAvatarUrl: me.user.avatarUrl ?? me.user.gravatarUrl ?? null,
        userName: me.user.displayName,
        userPresence: selfPresence?.state ?? 'offline',
        userStatusEmoji: selfPresence?.statusEmoji ?? null,
      }),
    )
  }, [me, nativeShellBridge, selfPresence?.state, selfPresence?.statusEmoji])

  if (!me) return null

  return (
    <>
      <button
        aria-haspopup="menu"
        aria-label="Account menu"
        className={[
          'rounded-md transition-shadow',
          nativeShellBridge ? 'pointer-events-none fixed right-3 top-0 z-[69] h-px w-px opacity-0' : '',
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
