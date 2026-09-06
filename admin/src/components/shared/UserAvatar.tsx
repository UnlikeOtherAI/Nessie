import { useAuthedObjectUrl, useAuthedObjectUrlFromPath } from '../../lib/uploads'
import { AvatarBadges } from './AvatarBadges'
import { IdentityTile } from '../primitives/IdentityTile'
import { identityInitials } from '../../lib/identity-shape'

// Everything that can identify a picture for a user. Precedence: the picture
// UnlikeOtherAI holds for them, then a locally uploaded attachment, then the
// provider (Google) picture, then initials.
export type AvatarSources = {
  avatarAttachmentId?: string
  avatarUrl?: string
  // Nessie user id. It resolves the UnlikeOtherAI-hosted avatar through the API
  // relay, so passing it upgrades the picture wherever it is available.
  userId?: string
  // UOA subject, for people named only by UOA — a team roster row may have
  // no local user row at all. It resolves the same picture through the
  // roster-scoped relay, which is why the two are alternatives, never a chain:
  // both end at the one image UOA holds for that person.
  uoaSub?: string
  // Bumping this refetches the relay after the signed-in person changes their
  // UOA picture, which lives at the same URL and would otherwise be served from
  // the browser cache. Only surfaces that can trigger that change pass it.
  revision?: number
}

/**
 * Pick the picture, given whatever the two authenticated byte endpoints have
 * resolved so far. UnlikeOtherAI comes first because it owns the profile of
 * everyone who signs in through it: a local upload can no longer sit on top of
 * the picture the person manages there. It stays in the chain for deployments
 * with no UOA, where the relay simply answers 404.
 *
 * Gravatar used to be the last image source. It is gone: it is derived from the
 * email address, which is UOA's data, and it leaked every member's address hash
 * to a third party to render a fallback that initials already cover.
 */
export const resolveAvatarSource = (
  sources: Pick<AvatarSources, 'avatarUrl'>,
  resolved: { customUrl: string | null; uoaUrl: string | null },
): string | null =>
  resolved.uoaUrl ?? resolved.customUrl ?? sources.avatarUrl ?? null

/**
 * Which authenticated relay serves this person's UnlikeOtherAI picture. A
 * Nessie user id goes through the organization-scoped relay; a person known
 * only by UOA subject (a team roster row with no local user) goes through
 * the roster-scoped one, which checks the subject against the same roster the
 * Members page is served from before relaying any bytes.
 */
export const uoaAvatarPath = (
  sources: Pick<AvatarSources, 'userId' | 'uoaSub'>,
): string | null => {
  if (sources.userId) return `/api/users/${sources.userId}/avatar`
  if (sources.uoaSub) {
    return `/api/team/members/${encodeURIComponent(sources.uoaSub)}/avatar`
  }
  return null
}

// Resolve the best avatar URL. The first two sources are authenticated byte
// endpoints fetched as object URLs; until one resolves (or if it fails — an
// unlinked user answers 404) the next source is used, and ultimately `null`
// (the caller renders initials).
export const useResolvedAvatarUrl = (
  sources: AvatarSources,
  token: string | null,
): string | null => {
  const customUrl = useAuthedObjectUrl(sources.avatarAttachmentId ?? null, token)
  // The relay answers image/png, image/jpeg, image/webp or (for UOA's generated
  // avatars) image/svg+xml, so the blob type is not pinned — it is rendered in
  // an <img>, which never runs scripts in an SVG, and the API allowlists the
  // upstream content type before any bytes reach the browser.
  const relayPath = uoaAvatarPath(sources)
  const uoaUrl = useAuthedObjectUrlFromPath(
    relayPath && sources.revision ? `${relayPath}?v=${sources.revision}` : relayPath,
    token,
  )
  return resolveAvatarSource(sources, {
    customUrl: sources.avatarAttachmentId ? customUrl : null,
    uoaUrl,
  })
}

type UserAvatarProps = AvatarSources & {
  displayName: string
  token: string | null
  // Rendered edge length in pixels.
  size?: number
  className?: string
  // Overlay the user's presence dot / active-status emoji. Both need `userId`.
  focusPresence?: boolean
  showPresence?: boolean
  showStatus?: boolean
  // Background the avatar sits on (for the badges' separating ring).
  ringColor?: string
  presenceRingWidth?: number
}

// A person's picture. Resolution (UnlikeOtherAI > local upload > Google >
// initials) lives here; the tile itself is the shared `IdentityTile`, so a
// person, an agent and a team are the same shape at the same size.
// Presence + active-status badges are opt-in.
export const UserAvatar = ({
  displayName,
  token,
  size = 32,
  className,
  focusPresence,
  showPresence,
  showStatus,
  ringColor,
  presenceRingWidth,
  ...sources
}: UserAvatarProps) => {
  const url = useResolvedAvatarUrl(sources, token)

  const tile = (
    <IdentityTile
      background="var(--accent)"
      className={className}
      color="var(--on-accent)"
      fallback={{ kind: 'initials', text: identityInitials(displayName) }}
      imageUrl={url}
      label={displayName}
      size={size}
    />
  )

  if (!sources.userId || (!showPresence && !showStatus)) {
    return tile
  }

  return (
    <AvatarBadges
      ringColor={ringColor}
      ringWidth={presenceRingWidth}
      focusPresence={focusPresence}
      showPresence={showPresence}
      showStatus={showStatus}
      size={size}
      userId={sources.userId}
    >
      {tile}
    </AvatarBadges>
  )
}
