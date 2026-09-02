import { useAuthedObjectUrlFromPath } from '../../lib/uploads'
import { IdentityTile } from './IdentityTile'
import { identityInitials } from './identity-shape'

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
  // UOA's public, always-resolving team-avatar endpoint. It covers directory
  // entries that have not been materialised as local Nessie teams yet.
  imageUrl?: string
  // A specific local team id makes the component use the membership-scoped
  // relay. `null` skips that relay so an unmaterialised SSO workspace can use
  // imageUrl (or initials when the public image is absent/broken); omitting the
  // id preserves the current-workspace endpoint used by settings.
  teamId?: string | null
}

/**
 * A workspace's picture. Prefers Nessie's authenticated relay, then UOA's
 * public directory image, and finally workspace initials; the tile is the
 * shared `IdentityTile`, so it matches a person and an agent at the same size.
 */
export const WorkspaceAvatar = ({
  label,
  token,
  size = 36,
  className,
  revision = 0,
  imageUrl,
  teamId,
}: WorkspaceAvatarProps) => {
  const path = workspaceAvatarPath(teamId)
  const relayedUrl = useAuthedObjectUrlFromPath(
    path && revision > 0 ? `${path}?v=${revision}` : path,
    token,
  )
  // Prefer the membership-scoped relay when it exists so an avatar changed in
  // Nessie can be cache-busted immediately. The public UOA URL fills the gap
  // for authorized workspaces that do not have a local Team row yet.
  const url = relayedUrl ?? imageUrl ?? null

  return (
    <IdentityTile
      background="var(--overlay)"
      className={className}
      color="var(--tx)"
      fallback={{ kind: 'initials', text: identityInitials(label, 'W') }}
      imageUrl={url}
      label={label}
      size={size}
    />
  )
}
