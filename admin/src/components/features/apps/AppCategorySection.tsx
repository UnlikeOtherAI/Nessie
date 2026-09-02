import { useAppShelfPages } from '../../../facades/apps/hooks'
import { AppCard } from './AppCard'
import {
  APP_GRID_CLASS,
  sectionOffersShowAll,
  sectionRemainingLabel,
  sectionToggleLabel,
  sectionVisibleApps,
  shelfKey,
  type AppShelfModel,
} from './app-catalogue-view'

type AppCategorySectionProps = {
  expanded: boolean
  /** The narrowing the page is under, so a page fetch asks the same question. */
  installed: boolean
  onToggleExpanded: () => void
  pageSize: number
  section: AppShelfModel
  /**
   * This shelf *is* the page — because the toolbar is narrowed to its category,
   * or because it is the flat Installed list. It then renders as a bare grid:
   * no heading, because the control directly above already reads "Communication
   * (150)" or "Installed (3)" and repeating it 40px lower says nothing new; no
   * two-row cap and no "Show all", because collapsing the only thing on the
   * page back to two rows is not a move anybody wants.
   */
  standalone?: boolean
}

export const appCategorySectionId = (category: string): string => `apps-category-${category}`

/**
 * One shelf of the catalogue, two rows deep by default.
 *
 * "Show all" expands **in place** rather than navigating: a person comparing
 * three shelves should never lose the other two to see the rest of one. What
 * changed with registry ingestion is where the rest comes from — a shelf can
 * hold hundreds of apps, so the catalogue response carries only a slice of each
 * and an expanded shelf fetches its own pages. The shelf owning that is what
 * keeps the page's card count proportional to what somebody asked to see
 * instead of to the size of the catalogue.
 *
 * The heading count and the "Show all N" label are the server's SQL total for
 * this shelf, never `apps.length` — the array is a slice, and a count taken
 * from it would shrink the shelf to whatever happened to fit.
 */
export const AppCategorySection = ({
  expanded,
  installed,
  onToggleExpanded,
  pageSize,
  section,
  standalone = false,
}: AppCategorySectionProps) => {
  // Narrowed to this one shelf, it *is* the page, so it starts open and keeps
  // paging: a person who picked "Communication" asked for all 150, not for two
  // rows of them.
  const open = standalone || expanded
  const partial = section.total > section.apps.length
  const pages = useAppShelfPages({
    category: section.category,
    enabled: open && partial,
    installed,
  })

  const loaded = pages.data?.pages.flatMap((page) => page.apps) ?? []
  // Until the first page lands the shelf stays on screen: replacing it with a
  // spinner would make "Show all" read as "clear the section".
  const visible = open && loaded.length > 0
    ? loaded
    : sectionVisibleApps(section, pageSize, open)
  const key = shelfKey(section)

  return (
    <section
      // The sticky bar sits over the top of the page, and it is taller on
      // phone where the filter row stacks under the search field.
      className={standalone ? 'mt-6' : 'mt-10 scroll-mt-32 lg:scroll-mt-20'}
      data-testid={`app-category-section-${key}`}
      id={appCategorySectionId(key)}
    >
      {standalone ? null : (
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
              data-testid={`app-category-toggle-${key}`}
              onClick={onToggleExpanded}
              type="button"
            >
              <span className="text-xs font-medium">{sectionToggleLabel(section, expanded)}</span>
            </button>
          ) : null}
        </div>
      )}
      <div className={APP_GRID_CLASS}>
        {visible.map((app) => (
          <AppCard app={app} key={app.id} />
        ))}
      </div>
      {open && pages.hasNextPage ? (
        <div className="mt-4 flex justify-center">
          <button
            className="admin-button admin-button-secondary"
            data-testid={`app-category-load-more-${key}`}
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
      {open && pages.isError ? (
        <p
          className="mt-4 text-center text-sm text-[color:var(--danger-text)]"
          data-testid={`app-category-error-${key}`}
          role="alert"
        >
          We couldn&apos;t load the rest of {section.label}. Try again in a moment.
        </p>
      ) : null}
    </section>
  )
}
