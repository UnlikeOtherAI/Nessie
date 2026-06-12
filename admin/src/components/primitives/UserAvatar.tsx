import { useEffect, useState } from 'react'
import { getInitials } from '../../lib/avatar'
import { useAuthedObjectUrl } from '../../lib/uploads'
import { AvatarBadges } from './AvatarBadges'

// Avatar source fields as carried on MeUser. Precedence: a custom uploaded
// attachment overrides the provider (Google) picture, which overrides Gravatar.
export type AvatarSources = {
  avatarAttachmentId?: string
  avatarUrl?: string
  gravatarUrl?: string
}

// Resolve the best avatar URL for the precedence custom > provider > gravatar.
// The custom avatar is an authenticated attachment, so it is fetched as an object
// URL; until it resolves (or if it fails) we fall back to the provider/Gravatar
// URL, and ultimately to `null` (the caller renders initials).
export const useResolvedAvatarUrl = (
  sources: AvatarSources,
  token: string | null,
): string | null => {
  const customUrl = useAuthedObjectUrl(sources.avatarAttachmentId ?? null, token)
  if (sources.avatarAttachmentId && customUrl) {
    return customUrl
  }
  return sources.avatarUrl ?? sources.gravatarUrl ?? null
}

type UserAvatarProps = AvatarSources & {
  displayName: string
  token: string | null
  // Rendered diameter in pixels.
  size?: number
  className?: string
  // When set, overlays the user's active-status emoji + presence dot.
  userId?: string
  showPresence?: boolean
  showStatus?: boolean
  // Background the avatar sits on (for the badges' separating ring).
  ringColor?: string
}

// Round user avatar: renders the resolved image (custom > Google > Gravatar) and
// falls back to initials on an empty source or a failed/404 image load. When a
// `userId` is supplied it is wrapped with presence + active-status badges.
export const UserAvatar = ({
  displayName,
  token,
  size = 32,
  className,
  userId,
  showPresence,
  showStatus,
  ringColor,
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
        'flex flex-shrink-0 items-center justify-center overflow-hidden rounded-full',
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

  if (!userId) {
    return circle
  }

  return (
    <AvatarBadges
      ringColor={ringColor}
      showPresence={showPresence}
      showStatus={showStatus}
      size={size}
      userId={userId}
    >
      {circle}
    </AvatarBadges>
  )
}
