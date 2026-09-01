/**
 * The placeholder shape a surface shows while its first load is in flight.
 *
 * Six of these existed — `AgentsTable`'s per-column bars, `ActiveSessionsTable`'s
 * rows, `AppSkeletons`' `Pulse`, `DashboardSectionCard`'s `SectionSkeleton`,
 * `WidgetFrame`'s and `EmbeddedWidget`'s — at four heights and three radii.
 *
 * A skeleton is the exception, not the default: {@link QueryState}'s single
 * loading line is what an ordinary list shows. Reach for this only where the
 * layout is already known and stable enough that drawing it empty is more
 * honest than a sentence — a table with fixed columns, a grid of cards. A
 * skeleton over a surface whose shape depends on the response is a lie about
 * what is coming.
 */

type SkeletonProps = {
  className?: string
  /** Tailwind height utility. Defaults to a line of body text. */
  height?: string
  /** Tailwind width utility; omit for full width. */
  width?: string
}

export const Skeleton = ({ className, height = 'h-4', width }: SkeletonProps) => (
  <div
    className={[
      'animate-pulse rounded bg-[color:var(--overlay-weak)]',
      height,
      width ?? 'w-full',
      className ?? '',
    ]
      .filter(Boolean)
      .join(' ')}
  />
)

type SkeletonRowsProps = {
  className?: string
  /** How many placeholder lines to draw. */
  count: number
}

/**
 * A stack of lines, for a list whose rows are all one height. `aria-hidden`
 * with a `role="status"` label on the wrapper: a screen reader should hear
 * "Loading" once, not one announcement per bar.
 */
export const SkeletonRows = ({ className, count }: SkeletonRowsProps) => (
  <div
    aria-label="Loading"
    className={['grid gap-2', className ?? ''].filter(Boolean).join(' ')}
    role="status"
  >
    {Array.from({ length: count }, (_, index) => (
      <Skeleton height="h-10" key={index} />
    ))}
  </div>
)
