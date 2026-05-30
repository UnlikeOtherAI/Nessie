/**
 * Shared avatar helpers — initials and gradient palettes used across the
 * admin UI (Avatar primitive, channel member lists, agent rows).
 */

/**
 * Derive up to two uppercase initials from a display name. Returns `fallback`
 * when no usable characters are present.
 */
export const getInitials = (value: string, fallback = 'N'): string =>
  value
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('') || fallback

/** Fixed gradient used for agent avatars. */
export const agentGradient = 'linear-gradient(135deg,#7c3aed,#6d28d9)'

/** Palette of member avatar gradients, indexed by a stable per-id hash. */
export const memberGradients = [
  'linear-gradient(135deg,#7c3aed,#4f46e5)',
  'linear-gradient(135deg,#0891b2,#0369a1)',
  'linear-gradient(135deg,#047857,#065f46)',
  'linear-gradient(135deg,#b45309,#92400e)',
  'linear-gradient(135deg,#be185d,#9d174d)',
  'linear-gradient(135deg,#1d4ed8,#1e40af)',
  'linear-gradient(135deg,#dc2626,#b91c1c)',
  'linear-gradient(135deg,#0d9488,#0f766e)',
] as const

/** Pick a member gradient deterministically from an id string. */
export const pickGradient = (id: string): string => {
  let hash = 0
  for (let i = 0; i < id.length; i++) {
    hash = ((hash << 5) - hash + id.charCodeAt(i)) | 0
  }
  return memberGradients[Math.abs(hash) % memberGradients.length] ?? memberGradients[0]
}

/** Index-based DM avatar gradients used by the sidebar rail. */
export const dmGradients = [
  'linear-gradient(135deg,#6d28d9,#4f46e5)',
  'linear-gradient(135deg,#1d4ed8,#0284c7)',
  'linear-gradient(135deg,#047857,#065f46)',
  'linear-gradient(135deg,#9333ea,#7c3aed)',
] as const

/** Inline style for a DM avatar, cycling through {@link dmGradients}. */
export const getDmStyle = (index: number) => ({
  background: dmGradients[index % dmGradients.length],
})
