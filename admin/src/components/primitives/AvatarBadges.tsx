import type { ReactNode } from 'react'
import { useUserPresence } from '../../providers/PresenceProvider'
import { PresenceBadge } from './PresenceBadge'

type AvatarBadgesProps = {
  // The user whose presence + active status to badge. Without it (or outside
  // the PresenceProvider) the children render unbadged.
  userId?: string | null
  // Diameter of the wrapped avatar in px.
  size: number
  children: ReactNode
  focusPresence?: boolean
  showPresence?: boolean
  showStatus?: boolean
  // Background the avatar sits on, used for the badges' separating ring.
  ringColor?: string
  ringWidth?: number
}

// Overlays the active-status emoji (top-right) and the presence dot
// (bottom-right) on any avatar tile. Reads live state from PresenceProvider
// so every human avatar across the app stays in sync.
export const AvatarBadges = ({
  userId,
  size,
  children,
  focusPresence = false,
  showPresence = true,
  showStatus = true,
  ringColor = 'var(--panel)',
  ringWidth = 2,
}: AvatarBadgesProps) => {
  const presence = useUserPresence(userId)

  if (!presence) {
    return <>{children}</>
  }

  const dotSize = Math.max(8, Math.round(size * 0.32))
  const statusSize = Math.max(14, Math.round(size * 0.5))
  const statusOffset = -Math.round(statusSize * 0.28)

  return (
    <span
      className="relative inline-flex flex-shrink-0"
      style={{ width: size, height: size }}
    >
      {children}
      {showStatus && presence.statusEmoji && (
        <span
          className="absolute flex items-center justify-center rounded-full"
          style={{
            top: statusOffset,
            right: statusOffset,
            width: statusSize,
            height: statusSize,
            fontSize: Math.round(statusSize * 0.62),
            lineHeight: 1,
            background: 'var(--panel)',
            boxShadow: `0 0 0 2px ${ringColor}`,
          }}
          title={presence.statusLabel ?? undefined}
        >
          {presence.statusEmoji}
        </span>
      )}
      {showPresence && (
        <span className="absolute" style={{ bottom: -1, right: -1 }}>
          <PresenceBadge
            focusModeEnabled={focusPresence}
            ringColor={ringColor}
            ringWidth={ringWidth}
            size={dotSize}
            state={presence.state}
          />
        </span>
      )}
    </span>
  )
}
