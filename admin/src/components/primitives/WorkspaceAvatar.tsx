import { useEffect, useState } from 'react'
import { getInitials } from '../../lib/avatar'
import { useAuthedObjectUrlFromPath } from '../../lib/uploads'

// The company picture UnlikeOtherAI holds for the signed-in workspace. The relay
// needs a bearer token, so it is fetched as an object URL rather than dropped
// into an <img src> (see lib/uploads).
export const WORKSPACE_AVATAR_PATH = '/api/workspace/avatar'

type WorkspaceAvatarProps = {
  // Falls back to these initials while loading, on failure, and for a workspace
  // with no UnlikeOtherAI counterpart (the relay answers 404).
  label: string
  token: string | null
  // Rendered edge length in pixels.
  size?: number
  className?: string
  // Bumping this refetches after an upload/remove, whose new image lives at the
  // same URL and would otherwise be served from the browser cache.
  revision?: number
}

/**
 * Square-cornered workspace avatar, the counterpart to the round `UserAvatar`.
 * Renders the UnlikeOtherAI company image when there is one and the workspace
 * initials otherwise, so it looks the same as it always did on a deployment with
 * no UOA configured.
 */
export const WorkspaceAvatar = ({
  label,
  token,
  size = 36,
  className,
  revision = 0,
}: WorkspaceAvatarProps) => {
  const url = useAuthedObjectUrlFromPath(
    revision > 0 ? `${WORKSPACE_AVATAR_PATH}?v=${revision}` : WORKSPACE_AVATAR_PATH,
    token,
  )
  const [broken, setBroken] = useState(false)

  useEffect(() => setBroken(false), [url])

  const showImage = Boolean(url) && !broken

  return (
    <span
      className={[
        'flex shrink-0 items-center justify-center overflow-hidden rounded-xl',
        'bg-[color:var(--overlay)] text-xs font-semibold text-[color:var(--tx)]',
        className ?? '',
      ].join(' ')}
      style={{ width: size, height: size }}
    >
      {showImage ? (
        <img
          alt={label}
          className="h-full w-full object-cover"
          onError={() => setBroken(true)}
          src={url ?? undefined}
        />
      ) : (
        getInitials(label, 'W')
      )}
    </span>
  )
}
