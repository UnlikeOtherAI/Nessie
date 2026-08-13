import type { PresenceState } from '../../lib/api-client'

type PresenceBadgeProps = {
  state: PresenceState
  // Dot diameter in px.
  size?: number
  // Colour of the separating ring — should match the background the dot sits on.
  ringColor?: string
  // Width of the separating ring. Navigation uses a wider cutout so the badge
  // appears to emerge from the sidebar rather than sit on top of the avatar.
  ringWidth?: number
}

// Three-state presence dot: filled green when online, an amber "z" when away
// (idle / tab hidden), and an empty muted ring when offline.
export const PresenceBadge = ({
  state,
  size = 10,
  ringColor = 'var(--panel)',
  ringWidth = 2,
}: PresenceBadgeProps) => {
  const base = {
    width: size,
    height: size,
    boxShadow: `0 0 0 ${ringWidth}px ${ringColor}`,
  }

  if (state === 'online') {
    return (
      <span
        aria-hidden
        className="block rounded-full"
        style={{ ...base, background: 'var(--success)' }}
      />
    )
  }

  if (state === 'offline') {
    return (
      <span
        aria-hidden
        className="block rounded-full"
        style={{ ...base, background: ringColor, border: '1.5px solid var(--muted)' }}
      />
    )
  }

  return (
    <span
      aria-hidden
      className="flex items-center justify-center rounded-full"
      style={{ ...base, background: 'var(--warning)', color: 'var(--ink)' }}
    >
      <svg
        fill="none"
        height={Math.round(size * 0.66)}
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.5"
        viewBox="0 0 10 10"
        width={Math.round(size * 0.66)}
      >
        <path d="M3 3.4 H7 L3 6.6 H7" />
      </svg>
    </span>
  )
}
