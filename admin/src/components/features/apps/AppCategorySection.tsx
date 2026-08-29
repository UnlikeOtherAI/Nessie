import { useAppCategoryPages } from '../../../facades/apps/hooks'
import { AppCard } from './AppCard'
import {
  APP_GRID_CLASS,
  sectionOffersShowAll,
  sectionRemainingLabel,
  sectionToggleLabel,
  sectionVisibleApps,
  type AppCategorySectionModel,
} from './app-catalogue-view'

type AppCategorySectionProps = {
  expanded: boolean
  /** The narrowing the page is under, so a page fetch asks the same question. */
  installed: boolean
  onToggleExpanded: () => void
  pageSize: number
  section: AppCategorySectionModel
}

export const appCategorySectionId = (category: string): string => `apps-category-${category}`

/**
 * One category, two rows deep by default.
 *
 * "Show all" expands **in place** rather than navigating: a person comparing
 * three shelves should never lose the other two to see the rest of one. What
 * changed with registry ingestion is where the rest comes from — a category can
 * hold hundreds of apps, so the catalogue response carries only a shelf of each
 * and an expanded section fetches its own pages. The section owning that is
 * what keeps the page's card count proportional to what somebody asked to see
 * instead of to the size of the catalogue.
 *
 * The heading count and the "Show all N" label are the server's SQL total for
 * this category, never `apps.length` — the array is a slice, and a count taken
 * from it would shrink the category to whatever happened to fit.
 */
export const AppCategorySection = ({
  expanded,
  installed,
  onToggleExpanded,
  pageSize,
  section,
}: AppCategorySectionProps) => {
  const partial = section.total > section.apps.length
  const pages = useAppCategoryPages({
    category: section.category,
    enabled: expanded && partial,
    installed,
  })

  const loaded = pages.data?.pages.flatMap((page) => page.apps) ?? []
  // Until the first page lands the shelf stays on screen: replacing it with a
  // spinner would make "Show all" read as "clear the section".
  const visible = expanded && loaded.length > 0
    ? loaded
    : sectionVisibleApps(section, pageSize, expanded)

  return (
    <section
      // The sticky bar sits over the top of the page, and it is taller on
      // phone where the filter row stacks under the search field.
      className="mt-10 scroll-mt-32 lg:scroll-mt-20"
      data-testid={`app-category-section-${section.category}`}
      id={appCategorySectionId(section.category)}
    >
      <div className="mb-4 flex items-baseline justify-between gap-4">
        <h2 className="flex items-baseline gap-2 text-base font-semibold text-[color:var(--tx)]">
          {section.label}
          <span className="text-sm font-normal text-[color:var(--tx3)]">
            ({section.total})
          </span>
        </h2>
        {sectionOffersShowAll(section, pageSize) ? (
          <button
            className="text-[color:var(--accent)] hover:text-[color:var(--accent-hover)]"
            data-testid={`app-category-toggle-${section.category}`}
            onClick={onToggleExpanded}
            type="button"
          >
            <span className="text-xs font-medium">{sectionToggleLabel(section, expanded)}</span>
          </button>
        ) : null}
      </div>
      <div className={APP_GRID_CLASS}>
        {visible.map((app) => (
          <AppCard app={app} key={app.id} />
        ))}
      </div>
      {expanded && pages.hasNextPage ? (
        <div className="mt-4 flex justify-center">
          <button
            className="admin-button admin-button-secondary"
            data-testid={`app-category-load-more-${section.category}`}
            disabled={pages.isFetchingNextPage}
            onClick={() => void pages.fetchNextPage()}
            type="button"
          >
            {pages.isFetchingNextPage
              ? 'Loading…'
              : sectionRemainingLabel(visible.length, section.total)}
          </button>
        </div>
      ) : null}
      {expanded && pages.isError ? (
        <p
          className="mt-4 text-center text-sm text-[color:var(--danger-text)]"
          data-testid={`app-category-error-${section.category}`}
          role="alert"
        >
          We couldn&apos;t load the rest of {section.label}. Try again in a moment.
        </p>
      ) : null}
    </section>
  )
}
