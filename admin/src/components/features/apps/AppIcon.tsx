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

// The app's mark, or its initials. Not a generic puzzle piece per app: a shelf
// of identical placeholder glyphs is harder to scan than a shelf of letters.
export const AppIcon = ({ displayName, iconUrl, size }: AppIconProps) => (
  <span
    className={[
      'inline-flex shrink-0 items-center justify-center overflow-hidden',
      'border border-[color:var(--line)] bg-[color:var(--panel-soft)]',
      TILE_SIZE[size],
    ].join(' ')}
  >
    {iconUrl ? (
      <img alt="" className="h-full w-full object-contain p-2" loading="lazy" src={iconUrl} />
    ) : (
      <span
        aria-hidden="true"
        className={[
          'font-semibold text-[color:var(--tx2)]',
          INITIALS_SIZE[size],
        ].join(' ')}
      >
        {appIconInitials(displayName)}
      </span>
    )}
  </span>
)
