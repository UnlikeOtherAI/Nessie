import { useAuthedObjectUrlFromPath } from '../../lib/uploads'
import { IdentityTile } from './IdentityTile'
import { identityInitials } from '../../lib/identity-shape'

// The company picture UnlikeOtherAI holds for a team. The relay needs a
// bearer token, so it is fetched as an object URL rather than dropped into an
// <img src> (see lib/uploads).
export const TEAM_AVATAR_PATH = '/api/team/avatar'

export const teamAvatarPath = (teamId?: string | null): string | null => {
  if (teamId === null) return null
  return teamId ? `/api/teams/${encodeURIComponent(teamId)}/avatar` : TEAM_AVATAR_PATH
}

type TeamAvatarProps = {
  // Falls back to these initials while loading, on failure, and for a team
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
  // The team directory and native chrome both draw this public URL. Shell
  // identity surfaces set this so selecting a team cannot replace that image
  // with a second resolver's result. A positive revision still takes the
  // relay: that is the just-uploaded current-team image and bypasses UOA's
  // five-minute public cache.
  directoryImageFirst?: boolean
  // A specific local team id makes the component use the membership-scoped
  // relay. `null` skips that relay so an unmaterialised SSO team can use
  // imageUrl (or initials when the public image is absent/broken); omitting the
  // id preserves the current-team endpoint used by settings.
  teamId?: string | null
}

/**
 * A team's picture. Prefers Nessie's authenticated relay, then UOA's
 * public directory image, and finally team initials; the tile is the
 * shared `IdentityTile`, so it matches a person and an agent at the same size.
 */
export const TeamAvatar = ({
  label,
  token,
  size = 36,
  className,
  revision = 0,
  imageUrl,
  directoryImageFirst = false,
  teamId,
}: TeamAvatarProps) => {
  const useDirectoryImage = directoryImageFirst && Boolean(imageUrl) && revision === 0
  const path = useDirectoryImage ? null : teamAvatarPath(teamId)
  const relayedUrl = useAuthedObjectUrlFromPath(
    path && revision > 0 ? `${path}?v=${revision}` : path,
    token,
  )
  // Most surfaces prefer the membership-scoped relay, which lets an avatar
  // changed in Nessie be cache-busted immediately. The shell instead keeps
  // the directory URL used by both its picker and the native chrome until an
  // in-session upload bumps revision; that avoids changing the identity image
  // merely because its team became selected.
  //
  // That public URL is passed through UNCHANGED, and deliberately so: UOA parses
  // this route's query with `.strict()` and allows only `style` and `size`
  // (API/src/routes/avatar/public-team.ts, API/src/routes/avatar/shared.ts), so
  // appending a `v=` cache-buster makes the request throw and the tile falls all
  // the way back to initials — trading a stale picture for no picture. The lane
  // is therefore left to `max-age=300` revalidation, which is also why the
  // native chrome revalidates with `If-None-Match` instead
  // (mobile/src/lib/native-avatar-source.ts).
  const url = useDirectoryImage
    ? imageUrl ?? relayedUrl ?? null
    : relayedUrl ?? imageUrl ?? null

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
