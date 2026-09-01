import { useAuthSession } from '../../../providers/AuthSessionProvider'
import { useAuthedObjectUrlFromPath } from '../../../lib/uploads'
import { appIconInitials } from './app-card-presentation'

type AppIconProps = {
  displayName: string
  /** Always a Nessie-served path; an upstream URL never reaches this component. */
  iconUrl: string | null
  size: 'card' | 'hero'
}

const TILE_SIZE: Record<AppIconProps['size'], string> = {
  card: 'h-12 w-12 rounded-[var(--radius-md)]',
  hero: 'h-16 w-16 rounded-[var(--radius-lg)]',
}

const INITIALS_SIZE: Record<AppIconProps['size'], string> = {
  card: 'text-sm',
  hero: 'text-lg',
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
 * an error state.
 */
export const AppIcon = ({ displayName, iconUrl, size }: AppIconProps) => {
  const { token } = useAuthSession()
  const objectUrl = useAuthedObjectUrlFromPath(iconUrl, token)

  return (
    <span
      className={[
        'inline-flex shrink-0 items-center justify-center overflow-hidden',
        'border border-[color:var(--line)] bg-[color:var(--panel-soft)]',
        TILE_SIZE[size],
      ].join(' ')}
    >
      {objectUrl ? (
        <img alt="" className="h-full w-full object-contain p-2" src={objectUrl} />
      ) : (
        <span
          aria-hidden="true"
          className={['font-semibold text-[color:var(--tx2)]', INITIALS_SIZE[size]].join(' ')}
        >
          {appIconInitials(displayName)}
        </span>
      )}
    </span>
  )
}
