import type { AppSummaryRecord } from '@nessie/schemas'
import { AppCard } from './AppCard'

type AppFeaturedStripProps = {
  apps: readonly AppSummaryRecord[]
}

// A shelf, not a category: a featured app also appears under its own category
// below, and that is the one duplication on the page that earns itself.
//
// The strip always scrolls horizontally, even where all of it fits. Wrapping it
// into a second row would make it read as another grid section and lose the
// distinction the strip exists to draw.
export const AppFeaturedStrip = ({ apps }: AppFeaturedStripProps) => {
  if (apps.length === 0) return null

  return (
    <section className="mt-6" data-testid="apps-featured">
      <h2 className="mb-4 flex items-baseline gap-2 text-base font-semibold text-[color:var(--tx)]">
        Featured
        <span className="text-sm font-normal text-[color:var(--tx3)]">({apps.length})</span>
      </h2>
      <div className="-mx-4 flex snap-x gap-4 overflow-x-auto px-4 pb-2 sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8">
        {apps.map((app) => (
          <AppCard app={app} key={app.id} layout="wide" />
        ))}
      </div>
    </section>
  )
}
