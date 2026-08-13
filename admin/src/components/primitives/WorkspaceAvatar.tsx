import { useEffect, useState } from 'react'
import { getInitials } from '../../lib/avatar'
import { useAuthedObjectUrlFromPath } from '../../lib/uploads'

// The company picture UnlikeOtherAI holds for a workspace. The relay needs a
// bearer token, so it is fetched as an object URL rather than dropped into an
// <img src> (see lib/uploads).
export const WORKSPACE_AVATAR_PATH = '/api/workspace/avatar'

export const workspaceAvatarPath = (teamId?: string | null): string | null => {
  if (teamId === null) return null
  return teamId ? `/api/teams/${encodeURIComponent(teamId)}/avatar` : WORKSPACE_AVATAR_PATH
}

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
  // A specific local team id makes the component use the membership-scoped
  // relay, which lets workspace pickers show every team's UOA picture. `null`
  // deliberately uses initials for an SSO workspace with no local membership;
  // omitting the id preserves the current-workspace endpoint used by settings.
  teamId?: string | null
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
  teamId,
}: WorkspaceAvatarProps) => {
  const path = workspaceAvatarPath(teamId)
  const url = useAuthedObjectUrlFromPath(
    path && revision > 0 ? `${path}?v=${revision}` : path,
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
