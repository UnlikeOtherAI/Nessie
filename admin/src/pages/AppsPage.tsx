import { faPlus } from '@fortawesome/free-solid-svg-icons'
import type { AppCategory } from '@nessie/schemas'
import { useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { AppCard } from '../components/features/apps/AppCard'
import { AppCategorySection } from '../components/features/apps/AppCategorySection'
import { AppFeaturedStrip } from '../components/features/apps/AppFeaturedStrip'
import { AppCatalogueSkeleton } from '../components/features/apps/AppSkeletons'
import { AppsToolbar } from '../components/features/apps/AppsToolbar'
import { CustomAppDialog } from '../components/features/apps/CustomAppDialog'
import { appDetailHref } from '../components/features/apps/app-card-presentation'
import {
  APP_GRID_CLASS,
  APP_GRID_FIVE_COLUMN_QUERY,
  APP_GRID_TWO_COLUMN_QUERY,
  CATALOGUE_FOOTER_NUDGE,
  appFilterOptions,
  appGridColumns,
  buildCategorySections,
  catalogueEmptyMessage,
  catalogueMatchTotal,
  filterApps,
  parseAppFilter,
  readStoredAppFilter,
  searchTruncationNote,
  sectionPageSize,
  visibleShelves,
  writeStoredAppFilter,
  type AppFilter,
} from '../components/features/apps/app-catalogue-view'
import {
  describeSearchResults,
  isAppSearchActive,
  searchResultsLabel,
} from '../components/features/apps/app-search'
import { AdminPageHeader } from '../components/shared/AdminPageHeader'
import { Notice } from '../components/primitives/Notice'
import { EmptyState } from '../components/shared/EmptyState'
import { useApps } from '../facades/apps/hooks'
import { useDebouncedValue } from '../hooks/useDebouncedValue'
import { registerViewportMediaQuery, useViewport } from '../hooks/useViewport'

/**
 * The Apps catalogue — the member's doorway to everything Nessie and its agents
 * can be connected to.
 *
 * It is a store, not an admin tool: one scrolling page of shelves and no
 * protocol vocabulary. What it is *not* any more is one request for everything.
 * The registry puts thousands of apps in this catalogue, so the server sends a
 * shelf per category with the true size of each, search comes back ranked and
 * capped, and a shelf a person opens fetches its own pages. Every number on
 * screen is one of those server-side counts.
 *
 * The page also never narrates data it is not showing. While a query is in
 * flight the previous results stay painted, so the results line, the empty
 * state, and the filter all read from `data.applied` — the request the rendered
 * rows actually answer — rather than from what the search box currently holds.
 *
 * Adding an app by address stays here too: the catalogue remains the one place
 * a person goes to connect what they need.
 */

// The two widths the named breakpoint scale cannot express, registered once so
// the grid's column count in TS matches the columns CSS actually paints.
registerViewportMediaQuery('apps-grid-2col', APP_GRID_TWO_COLUMN_QUERY)
registerViewportMediaQuery('apps-grid-5col', APP_GRID_FIVE_COLUMN_QUERY)

export const AppsPage = () => {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const [query, setQuery] = useState('')
  const [expandedCategories, setExpandedCategories] = useState<Record<string, boolean>>({})
  const [activeCategory, setActiveCategory] = useState<AppCategory | null>(null)
  const [customAppDialogOpen, setCustomAppDialogOpen] = useState(false)

  // 150 ms is below the threshold where typing feels laggy and above the rate
  // at which re-requesting would churn.
  const debouncedQuery = useDebouncedValue(query, 150)
  // A pasted URL remains an explicit view; on the normal `/apps` doorway, use
  // the last catalogue view selected on this device so returning here does not
  // make someone re-select Installed every time.
  const requestedFilter = searchParams.get('filter')
  const filter = requestedFilter === null ? readStoredAppFilter() : parseAppFilter(requestedFilter)
  // Both narrowings go to the server. The query does because Postgres owns the
  // weighted ranking and the typo fallback; "Installed" does because the
  // response is a bounded slice, and filtering a slice would hide connected
  // apps that are simply on another page while contradicting the count on the
  // control that applied it.
  const { data, isError, isPending } = useApps({
    // The category dropdown narrows server-side for the same reason the other
    // two do: the response is a bounded slice per category, so filtering it in
    // the browser would hide apps that are merely on another page and make the
    // count beside the control a lie.
    category: activeCategory ?? undefined,
    installed: filter === 'installed',
    query: isAppSearchActive(debouncedQuery) ? debouncedQuery : undefined,
  })
  const viewport = useViewport()

  const columns = appGridColumns({
    twoColumns: viewport.media?.['apps-grid-2col'] ?? false,
    threeColumns: viewport.atLeast.md,
    fourColumns: viewport.atLeast.xl,
    fiveColumns: viewport.media?.['apps-grid-5col'] ?? false,
  })
  const pageSize = sectionPageSize(columns)

  // Everything below describes the response on screen, not the input in hand.
  const response = data?.response
  const shownQuery = data?.applied.query ?? ''
  const shownFilter: AppFilter = data?.applied.installed === true ? 'installed' : 'all'
  const searching = isAppSearchActive(shownQuery)

  const results = useMemo(
    () => (searching ? describeSearchResults(response?.apps ?? [], shownQuery) : []),
    [response, searching, shownQuery],
  )
  const sections = useMemo(
    () => (searching ? [] : buildCategorySections(response?.apps ?? [], response?.categories ?? [])),
    [response, searching],
  )
  /**
   * What the shelves show. Narrowed to a category, that is *only* that
   * category.
   *
   * The server deliberately keeps counting every category while `?category=`
   * narrows the slice, so the dropdown can offer the ones you are not looking
   * at — but the page rendered a section per *counted* category, so picking
   * "Communication" still painted fifteen other headings and left the apps
   * below the fold. `sections` stays whole for the toolbar; only the body
   * narrows.
   */
  const shelves = useMemo(
    () => visibleShelves(sections, activeCategory),
    [sections, activeCategory],
  )
  // The strip is the one list the server sends whole (five records at most), so
  // narrowing it here drops nothing the next page would have held. Under a
  // category it is hidden outright: a Featured shelf holding four apps from
  // other categories is the same interruption as the other headings were.
  const featured = useMemo(
    () => (searching || activeCategory ? [] : filterApps(response?.featured ?? [], shownFilter)),
    [response, shownFilter, searching, activeCategory],
  )
  // Summed from per-category aggregates, so a capped result list still reports
  // how many apps actually matched.
  const matchTotal = catalogueMatchTotal(response?.categories ?? [])

  const setFilter = (next: AppFilter) => {
    writeStoredAppFilter(next)
    const params = new URLSearchParams(searchParams)
    if (next === 'all') params.delete('filter')
    else params.set('filter', next)
    setSearchParams(params, { replace: true })
  }

  const openCustomAppDialog = () => setCustomAppDialogOpen(true)

  const empty = searching ? results.length === 0 : shelves.length === 0
  const emptyModel = catalogueEmptyMessage({
    filter: shownFilter,
    query: shownQuery,
    totalCount: response?.totalCount ?? 0,
  })
  const truncation = searchTruncationNote(results.length, matchTotal)

  return (
    <div className="flex h-full flex-col">
      <AdminPageHeader
        actions={[
          {
            icon: faPlus,
            id: 'apps-add-custom',
            label: 'Add a custom app',
            onSelect: openCustomAppDialog,
            primary: true,
            priority: 0,
          },
        ]}
        title="Apps"
        titleTone="page"
      />
      {/*
        Full-bleed, like the agents list (c29c6f6a): a store is a shelf, and a
        centred column wastes the width the grid exists to use — at five
        columns on a wide screen that is the difference between seeing ten apps
        and seeing twenty. No subtitle: the heading already says Apps, and a
        line explaining that apps connect you to tools names no decision
        (AGENTS.md rule zero #3).
      */}
      <div className="min-h-0 flex-1 overflow-y-auto bg-[color:var(--main)]">
        <div className="w-full px-4 py-6 sm:px-6 lg:px-8">
          <AppsToolbar
            activeCategory={activeCategory}
            filter={filter}
            filterOptions={appFilterOptions({
              installedCount: response?.installedCount ?? 0,
              totalCount: response?.totalCount ?? 0,
            })}
            onFilterChange={setFilter}
            onQueryChange={setQuery}
            onSelectCategory={setActiveCategory}
            query={query}
            sections={sections}
          />

          {isPending ? (
            <AppCatalogueSkeleton />
          ) : isError ? (
            // Never let a failed load render as "nothing is published" — that
            // is a different fact with a different next move.
            <Notice className="mt-8" role="alert" tone="danger">
              We couldn&apos;t load the app catalogue. Refresh the page to try again.
            </Notice>
          ) : empty ? (
            <div className="mt-8" data-testid="apps-empty">
              <EmptyState>
                <p>{emptyModel.message}</p>
                <button
                  className="admin-button admin-button-secondary mt-3"
                  data-testid="apps-empty-add-custom"
                  onClick={openCustomAppDialog}
                  type="button"
                >
                  {emptyModel.actionLabel}
                </button>
              </EmptyState>
            </div>
          ) : searching ? (
            <div className="mt-6" data-testid="apps-search-results">
              <div className="mb-4">
                <p className="text-sm text-[color:var(--tx3)]">
                  {searchResultsLabel(matchTotal, shownQuery)}
                </p>
                {truncation ? (
                  <p
                    className="mt-1 text-xs text-[color:var(--tx3)]"
                    data-testid="apps-search-capped"
                  >
                    {truncation}
                  </p>
                ) : null}
              </div>
              <div className={APP_GRID_CLASS}>
                {results.map((result) => (
                  <AppCard
                    app={result.app}
                    key={result.app.id}
                    provenance={result.provenance}
                    query={shownQuery}
                  />
                ))}
              </div>
            </div>
          ) : (
            <>
              <AppFeaturedStrip apps={featured} />
              {shelves.map((section) => (
                <AppCategorySection
                  expanded={expandedCategories[section.category] === true}
                  installed={shownFilter === 'installed'}
                  key={section.category}
                  onToggleExpanded={() =>
                    setExpandedCategories((current) => ({
                      ...current,
                      [section.category]: current[section.category] !== true,
                    }))
                  }
                  pageSize={pageSize}
                  section={section}
                  standalone={activeCategory !== null}
                />
              ))}
            </>
          )}

          {/* The escape hatch exists before a person has failed to find what
              they came for, not only after. */}
          <div className="mt-10" data-testid="apps-footer-nudge">
            <EmptyState>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <span>{CATALOGUE_FOOTER_NUDGE.message}</span>
                <button
                  className="admin-button admin-button-secondary"
                  data-testid="apps-footer-add-custom"
                  onClick={openCustomAppDialog}
                  type="button"
                >
                  {CATALOGUE_FOOTER_NUDGE.actionLabel}
                </button>
              </div>
            </EmptyState>
          </div>
        </div>
      </div>
      <CustomAppDialog
        onAdded={(app) => {
          void navigate(`${appDetailHref(app)}?connect=true`)
        }}
        onClose={() => setCustomAppDialogOpen(false)}
        open={customAppDialogOpen}
      />
    </div>
  )
}
