import { useAuthSession } from '../../../providers/AuthSessionProvider'
import { useAuthedObjectUrlFromPath } from '../../../lib/uploads'
import { IdentityTile } from '../../primitives/IdentityTile'
import { appIconInitials } from './app-card-presentation'

type AppIconProps = {
  displayName: string
  /** Always a Nessie-served path; an upstream URL never reaches this component. */
  iconUrl: string | null
  size: 'badge' | 'card' | 'hero'
}

const TILE_PX: Record<AppIconProps['size'], number> = {
  // The service mark in a chat card's top-left corner.
  badge: 24,
  card: 48,
  hero: 64,
}

/**
 * The app's mark, or its initials. Not a generic puzzle piece per app: a shelf
 * of identical placeholder glyphs is harder to scan than a shelf of letters.
 *
 * The bytes are fetched **with the session token and turned into a blob**, via
 * the same `useAuthedObjectUrlFromPath` an agent avatar uses — never
 * `<img src="/api/…">`. Two reasons, and the naive version fails both: the
 * admin and the API are different origins (`app.` vs `api.`, 5455 vs 5454 in
 * dev), so a root-relative path resolves against the static admin host; and an
 * `<img>` cannot carry an `Authorization` header, so the request would 401 even
 * pointed correctly. The store rendered every card as a monogram partly for
 * this reason alone.
 *
 * No `mimeOverride`: this renders in an `<img>`, which executes nothing, and
 * the icon bytes were MIME-sniffed server-side to PNG/JPEG/WebP before storage.
 * The override exists for `<iframe>` previews of caller-supplied uploads.
 *
 * A null path, a 404 (the app has no icon), or a failed fetch all land on the
 * initials — which is the ordinary outcome for roughly half the catalogue, not
 * an error state. The tile itself is the shared `IdentityTile`, so an app mark
 * is the same shape as the agent avatar beside it.
 */
export const AppIcon = ({ displayName, iconUrl, size }: AppIconProps) => {
  const { token } = useAuthSession()
  const objectUrl = useAuthedObjectUrlFromPath(iconUrl, token)
  const dimension = TILE_PX[size]

  return (
    <IdentityTile
      background="var(--panel-soft)"
      border
      color="var(--tx2)"
      fallback={{ kind: 'initials', text: appIconInitials(displayName) }}
      fit="contain"
      imageUrl={objectUrl}
      label={displayName}
      pad={size === 'badge' ? 2 : 8}
      size={dimension}
    />
  )
}
