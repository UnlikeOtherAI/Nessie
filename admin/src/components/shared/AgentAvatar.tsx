import { AGENT_AVATAR_BACKGROUND_COLORS } from '@nessie/schemas'

import { useAuthedObjectUrl } from '../../lib/uploads'
import { useAgentIdentity } from '../../providers/AgentIdentityProvider'
import { IdentityTile } from '../primitives/IdentityTile'
import { getAgentGlyph, type AgentIdentity } from './agent-identity'

export type { AgentIdentity } from './agent-identity'
export { getAgentGlyph } from './agent-identity'

/** Retained name for the many call sites that already import it. */
export type AgentAvatarSource = AgentIdentity

type AgentAvatarProps = {
  /** Whatever the call site already holds. May be partial, or absent. */
  agent?: AgentAvatarSource | null
  /** Resolves the agent through the identity directory when no record is held. */
  agentId?: string | null
  className?: string
  muted?: boolean
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl' | number
  token: string | null
}

const NAMED_SIZES = {
  xs: 24,
  sm: 32,
  md: 36,
  lg: 46,
  xl: 96,
} as const

export const agentAvatarPx = (size: NonNullable<AgentAvatarProps['size']>): number =>
  typeof size === 'number' ? size : NAMED_SIZES[size]

/**
 * The palette entry an agent falls back to, derived from its id so the same
 * agent keeps the same colour on every surface without storing one.
 */
const fallbackBackgroundColor = (agentId?: string | null): string => {
  const hash = [...(agentId ?? '')].reduce(
    (value, character) => (value * 31 + character.charCodeAt(0)) >>> 0,
    0,
  )
  return AGENT_AVATAR_BACKGROUND_COLORS[hash % AGENT_AVATAR_BACKGROUND_COLORS.length]!
}

/**
 * An agent's picture, on every surface.
 *
 * The call site hands in whatever it holds — a full `AgentRecord`, a partial
 * projection, or only an id — and the agent identity directory upgrades it.
 * That upgrade is the point: a surface that knew only an id used to render the
 * `⚡` placeholder, so the Personal Assistant appeared as a bolt in a thread
 * panel while its real portrait sat in the sidebar.
 */
export const AgentAvatar = ({
  agent,
  agentId,
  className,
  muted = false,
  size = 'md',
  token,
}: AgentAvatarProps) => {
  const resolvedId = agentId ?? agent?.id ?? null
  const directoryEntry = useAgentIdentity(resolvedId)
  // The directory wins on the picture, the caller wins on the label: a call
  // site naming an agent (a product assistant's display label, a PA presence's
  // display name) is stating what this surface should call it.
  const identity: AgentIdentity | null = directoryEntry
    ? { ...directoryEntry, name: agent?.name ?? directoryEntry.name, role: agent?.role ?? directoryEntry.role }
    : agent ?? null
  const attachmentId = identity?.avatarAttachmentId ?? null
  const objectUrl = useAuthedObjectUrl(attachmentId, token)
  const dimension = agentAvatarPx(size)

  return (
    <IdentityTile
      background={identity?.avatarBackgroundColor ?? fallbackBackgroundColor(resolvedId)}
      className={className}
      fallback={{ kind: 'glyph', glyph: getAgentGlyph(identity) }}
      imageUrl={attachmentId ? objectUrl : null}
      label={identity?.name ? `${identity.name} avatar` : 'Agent avatar'}
      muted={muted}
      size={dimension}
    />
  )
}
