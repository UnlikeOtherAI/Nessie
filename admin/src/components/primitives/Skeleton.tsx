/**
 * One skeleton, four shapes — the placeholder every screen shows on its first
 * load (docs/navigation.md §"Arriving with content").
 *
 * The stack slides for 300 ms and the destination has to have something to
 * show for it. Three unrelated skeleton systems used to answer that on two
 * different tokens (`--overlay` in the agents table and the project sections,
 * `--overlay-weak` in the app cards, a bare `--panel` rectangle on a dashboard
 * tile), so the same "still loading" fact read as three different greys
 * depending on which screen you landed on. The shimmer lives here and nowhere
 * else; `admin/test/skeleton.test.ts` pins that.
 *
 * A skeleton is the exception, not the default: the content kit's
 * `QueryState` single loading line is what an ordinary list shows. Reach for a
 * skeleton only where the layout is already known and stable enough that
 * drawing it empty is more honest than a sentence — a table with fixed
 * columns, a grid of cards. A skeleton over a surface whose shape depends on
 * the response is a lie about what is coming.
 *
 * A variant is a *page type*, not a component: `list` for a column of rows,
 * `detail` for one entity's header and prose, `feed` for a conversation,
 * `board` for a grid of cards. A screen picks the one its content is shaped
 * like, so the reveal lands on a plausible shell rather than a blank panel.
 */

export type SkeletonVariant = 'board' | 'detail' | 'feed' | 'list'

type SkeletonProps = {
  className?: string
  /** Rows for `list`/`feed`, cards for `board`. Ignored by `detail`. */
  count?: number
  variant: SkeletonVariant
}

const PULSE = 'animate-pulse rounded bg-[color:var(--overlay-weak)]'

/**
 * One shimmering rectangle, sized by the caller. For the few placeholders that
 * are a single shape rather than a page — a dashboard tile holding its grid
 * cell open, a pill standing in for a count.
 */
export const SkeletonBlock = ({ className = '' }: { className?: string }) => (
  <div aria-hidden="true" className={`${PULSE} ${className}`.trim()} />
)

const keys = (count: number) => Array.from({ length: count }, (_, index) => index)

const ListRows = ({ count }: { count: number }) => (
  <div className="flex flex-col gap-3">
    {keys(count).map((index) => (
      <div className="flex items-center gap-3" key={index}>
        <SkeletonBlock className="h-7 w-7 flex-shrink-0 rounded-full" />
        <SkeletonBlock className="h-4 flex-1" />
      </div>
    ))}
  </div>
)

const FeedRows = ({ count }: { count: number }) => (
  <div className="flex flex-col gap-5">
    {keys(count).map((index) => (
      <div className="flex items-start gap-3" key={index}>
        <SkeletonBlock className="h-8 w-8 flex-shrink-0 rounded-full" />
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <SkeletonBlock className="h-3 w-32" />
          <SkeletonBlock className="h-3 w-full" />
          {/* The second line is short on every other row, so a waiting feed
              reads as messages rather than as a striped block. */}
          <SkeletonBlock className={index % 2 === 0 ? 'h-3 w-3/5' : 'h-3 w-4/5'} />
        </div>
      </div>
    ))}
  </div>
)

const DetailShell = () => (
  <div className="flex flex-col gap-6">
    <div className="flex gap-4">
      <SkeletonBlock className="h-16 w-16" />
      <div className="flex min-w-0 flex-1 flex-col gap-3 pt-1">
        <SkeletonBlock className="h-6 w-56" />
        <SkeletonBlock className="h-3 w-72" />
      </div>
    </div>
    <div className="flex flex-col gap-2">
      <SkeletonBlock className="h-3 w-full" />
      <SkeletonBlock className="h-3 w-11/12" />
      <SkeletonBlock className="h-3 w-2/3" />
    </div>
  </div>
)

const BoardCards = ({ count }: { count: number }) => (
  <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
    {keys(count).map((index) => (
      <div
        className={[
          'flex h-full flex-col gap-3 p-4',
          'rounded-[var(--radius-lg)] border border-[color:var(--line)] bg-[color:var(--panel)]',
        ].join(' ')}
        key={index}
      >
        <div className="flex items-start gap-3">
          <SkeletonBlock className="h-12 w-12" />
          <div className="flex min-w-0 flex-1 flex-col gap-2 pt-1">
            <SkeletonBlock className="h-4 w-2/3" />
            <SkeletonBlock className="h-3 w-1/3" />
          </div>
        </div>
        <SkeletonBlock className="h-3 w-full" />
        <SkeletonBlock className="h-3 w-4/5" />
      </div>
    ))}
  </div>
)

const DEFAULT_COUNT: Record<SkeletonVariant, number> = {
  board: 8,
  detail: 1,
  feed: 4,
  list: 3,
}

export const Skeleton = ({ className, count, variant }: SkeletonProps) => {
  const items = count ?? DEFAULT_COUNT[variant]

  return (
    <div
      aria-busy="true"
      className={className}
      data-skeleton={variant}
      // A skeleton is a placeholder for content that has not arrived; a screen
      // reader is told the region is busy and given nothing to read out.
      role="presentation"
    >
      {variant === 'board' ? <BoardCards count={items} /> : null}
      {variant === 'detail' ? <DetailShell /> : null}
      {variant === 'feed' ? <FeedRows count={items} /> : null}
      {variant === 'list' ? <ListRows count={items} /> : null}
    </div>
  )
}
