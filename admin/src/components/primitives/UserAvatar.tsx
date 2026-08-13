import { useEffect, useState } from 'react'
import { getInitials } from '../../lib/avatar'
import { useAuthedObjectUrl, useAuthedObjectUrlFromPath } from '../../lib/uploads'
import { AvatarBadges } from './AvatarBadges'

// Everything that can identify a picture for a user. Precedence: a custom
// uploaded attachment, then the picture the user manages in UnlikeOtherAI, then
// the provider (Google) picture, then Gravatar.
export type AvatarSources = {
  avatarAttachmentId?: string
  avatarUrl?: string
  gravatarUrl?: string
  // Nessie user id. It resolves the UnlikeOtherAI-hosted avatar through the API
  // relay, so passing it upgrades the picture wherever it is available.
  userId?: string
}

// Resolve the best avatar URL for the precedence
// custom > UnlikeOtherAI > provider > gravatar.
//
// The first two are authenticated byte endpoints, so they are fetched as object
// URLs; until one resolves (or if it fails — an unlinked user answers 404) we
// fall back to the next source, and ultimately to `null` (the caller renders
// initials).
export const useResolvedAvatarUrl = (
  sources: AvatarSources,
  token: string | null,
): string | null => {
  const customUrl = useAuthedObjectUrl(sources.avatarAttachmentId ?? null, token)
  // The relay answers image/png, image/jpeg, image/webp or (for UOA's generated
  // avatars) image/svg+xml, so the blob type is not pinned — it is rendered in
  // an <img>, which never runs scripts in an SVG, and the API allowlists the
  // upstream content type before any bytes reach the browser.
  const uoaUrl = useAuthedObjectUrlFromPath(
    sources.userId ? `/api/users/${sources.userId}/avatar` : null,
    token,
  )
  if (sources.avatarAttachmentId && customUrl) {
    return customUrl
  }
  return uoaUrl ?? sources.avatarUrl ?? sources.gravatarUrl ?? null
}

type UserAvatarProps = AvatarSources & {
  displayName: string
  token: string | null
  // Rendered diameter in pixels.
  size?: number
  className?: string
  // Overlay the user's presence dot / active-status emoji. Both need `userId`.
  showPresence?: boolean
  showStatus?: boolean
  // Background the avatar sits on (for the badges' separating ring).
  ringColor?: string
  presenceRingWidth?: number
  shape?: 'circle' | 'rounded'
}

// Round user avatar: renders the resolved image (custom > UnlikeOtherAI >
// Google > Gravatar) and falls back to initials on an empty source or a
// failed/404 image load. Presence + active-status badges are opt-in.
export const UserAvatar = ({
  displayName,
  token,
  size = 32,
  className,
  showPresence,
  showStatus,
  ringColor,
  presenceRingWidth,
  shape = 'circle',
  ...sources
}: UserAvatarProps) => {
  const url = useResolvedAvatarUrl(sources, token)
  const [broken, setBroken] = useState(false)

  // Reset the error flag whenever the source URL changes (e.g. a custom upload
  // finishes loading after the Gravatar fallback was shown).
  useEffect(() => setBroken(false), [url])

  const showImage = Boolean(url) && !broken

  const circle = (
    <div
      aria-hidden="true"
      className={[
        'flex flex-shrink-0 items-center justify-center overflow-hidden',
        shape === 'rounded' ? 'rounded-lg' : 'rounded-full',
        'font-bold text-[color:var(--on-accent)]',
        className ?? '',
      ].join(' ')}
      style={{ width: size, height: size, background: 'var(--accent)', fontSize: Math.round(size * 0.36) }}
    >
      {showImage ? (
        <img
          alt={displayName}
          className="h-full w-full object-cover"
          onError={() => setBroken(true)}
          src={url ?? undefined}
        />
      ) : (
        <span>{getInitials(displayName)}</span>
      )}
    </div>
  )

  if (!sources.userId || (!showPresence && !showStatus)) {
    return circle
  }

  return (
    <AvatarBadges
      ringColor={ringColor}
      ringWidth={presenceRingWidth}
      showPresence={showPresence}
      showStatus={showStatus}
      size={size}
      userId={sources.userId}
    >
      {circle}
    </AvatarBadges>
  )
}
