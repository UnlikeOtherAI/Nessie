import { APP_GRID_CLASS } from './app-catalogue-view'

/**
 * First-cold-load placeholders only. Nothing here ever waits on a registry
 * sync, a capability probe, or sign-in discovery — those land afterwards and
 * update a card in place, because a store that greys out while it thinks is a
 * store nobody browses.
 *
 * Surfaces stay on `--panel` / `--overlay-weak`: a skeleton carries no status,
 * so it carries no status colour.
 */

const Pulse = ({ className }: { className: string }) => (
  <div className={`animate-pulse rounded bg-[color:var(--overlay-weak)] ${className}`} />
)

export const AppCardSkeleton = () => (
  <div
    className={[
      'flex h-full flex-col gap-3 p-4',
      'rounded-[var(--radius-lg)] border border-[color:var(--line)] bg-[color:var(--panel)]',
    ].join(' ')}
  >
    <div className="flex items-start gap-3">
      <Pulse className="h-12 w-12" />
      <div className="flex min-w-0 flex-1 flex-col gap-2 pt-1">
        <Pulse className="h-4 w-2/3" />
        <Pulse className="h-3 w-1/3" />
      </div>
    </div>
    <Pulse className="h-3 w-full" />
    <Pulse className="h-3 w-4/5" />
    <div className="mt-auto flex items-center justify-end pt-1">
      <Pulse className="h-8 w-24" />
    </div>
  </div>
)

const SkeletonSection = () => (
  <section className="mt-10">
    <Pulse className="mb-4 h-5 w-40" />
    <div className={APP_GRID_CLASS}>
      {[0, 1, 2, 3].map((index) => (
        <AppCardSkeleton key={index} />
      ))}
    </div>
  </section>
)

export const AppCatalogueSkeleton = () => (
  <div data-testid="apps-skeleton">
    <SkeletonSection />
    <SkeletonSection />
  </div>
)

export const AppDetailSkeleton = () => (
  <div className="grid gap-6" data-testid="app-detail-skeleton">
    <div
      className={[
        'flex gap-4 p-6',
        'rounded-[var(--radius-xl)] border border-[color:var(--line)] bg-[color:var(--panel)]',
      ].join(' ')}
    >
      <Pulse className="h-16 w-16" />
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <Pulse className="h-6 w-56" />
        <Pulse className="h-3 w-72" />
        <Pulse className="h-3 w-full max-w-lg" />
        <Pulse className="mt-2 h-9 w-52" />
      </div>
    </div>
    <Pulse className="h-4 w-64" />
  </div>
)
