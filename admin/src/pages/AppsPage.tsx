import { faPlus } from '@fortawesome/free-solid-svg-icons'
import type { AppCategory } from '@nessie/schemas'
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { AppCard } from '../components/features/apps/AppCard'
import { AppCategorySection } from '../components/features/apps/AppCategorySection'
import { AppFeaturedStrip } from '../components/features/apps/AppFeaturedStrip'
import { Skeleton } from '../components/primitives/Skeleton'
import { AppsToolbar } from '../components/features/apps/AppsToolbar'
import { CustomAppDialog } from '../components/features/apps/CustomAppDialog'
import { useTabParam } from '../navigation/useTabParam'
import { appDetailHref } from '../components/features/apps/app-card-presentation'
import {
  APP_GRID_CLASS,
  APP_GRID_FIVE_COLUMN_QUERY,
  APP_GRID_TWO_COLUMN_QUERY,
  APP_FILTER_ORDER,
  CATALOGUE_FOOTER_NUDGE,
  appFilterOptions,
  appGridColumns,
  buildCategorySections,
  catalogueEmptyMessage,
  catalogueMatchTotal,
  filterApps,
  installedShelf,
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
import { Notice } from '../components/primitives/Notice'
import { ScreenHeader } from '../components/shared/ScreenHeader'
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
  const [query, setQuery] = useState('')
  const [expandedCategories, setExpandedCategories] = useState<Record<string, boolean>>({})
  const [activeCategory, setActiveCategory] = useState<AppCategory | null>(null)
  const [customAppDialogOpen, setCustomAppDialogOpen] = useState(false)
  // Read once per mount: the stored view is the *default* for a URL that
  // carries no `?filter=`, and re-reading it after every write would make the
  // hook's "selecting the default clears the param" rule chase its own tail.
  const [storedFilter] = useState(readStoredAppFilter)

  // 150 ms is below the threshold where typing feels laggy and above the rate
  // at which re-requesting would churn.
  const debouncedQuery = useDebouncedValue(query, 150)
  // The catalogue view lives in `?filter=` through the one tab-state hook
  // (docs/navigation/overview.md §1, "Tab hosts"), seeded from the last view selected on
  // this device so the plain `/apps` doorway does not make someone re-select
  // Installed every time. A pasted URL still wins.
  const [filter, selectFilter] = useTabParam('filter', APP_FILTER_ORDER, storedFilter)
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
  // other categories is the same interruption as the other headings were. Under
  // Installed it is hidden for a stronger reason — with nothing curated the
  // strip falls back to the connected apps, which is the flat list directly
  // below it, card for card.
  const featured = useMemo(
    () =>
      searching || activeCategory || shownFilter === 'installed'
        ? []
        : filterApps(response?.featured ?? [], shownFilter),
    [response, shownFilter, searching, activeCategory],
  )
  /**
   * Installed is one flat shelf spanning every category.
   *
   * Category headings are how a person browses a catalogue of thousands; they
   * are not how anybody reads their own six connected apps, where three
   * headings over one card each is all frame and no shelf. Narrowing to a
   * category from the dropdown still works — that shelf renders standalone,
   * which is a bare grid too — so the whole Installed view is flat either way.
   */
  const installedFlatShelf = useMemo(
    () => installedShelf(response?.apps ?? [], response?.installedCount ?? 0),
    [response],
  )
  const flatInstalled = shownFilter === 'installed' && activeCategory === null
  // Summed from per-category aggregates, so a capped result list still reports
  // how many apps actually matched.
  const matchTotal = catalogueMatchTotal(response?.categories ?? [])

  const setFilter = (next: AppFilter) => {
    writeStoredAppFilter(next)
    selectFilter(next)
  }

  const openCustomAppDialog = () => setCustomAppDialogOpen(true)

  const empty = searching
    ? results.length === 0
    : flatInstalled
      ? installedFlatShelf.apps.length === 0
      : shelves.length === 0
  const emptyModel = catalogueEmptyMessage({
    filter: shownFilter,
    query: shownQuery,
    totalCount: response?.totalCount ?? 0,
  })
  const truncation = searchTruncationNote(results.length, matchTotal)

  return (
    <div className="flex h-full flex-col">
      <ScreenHeader
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
        <div className="w-full px-[var(--page-gutter)] py-6">
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
            <Skeleton className="mt-10" variant="board" />
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
                <div className="mt-3 flex flex-wrap gap-2">
                  {emptyModel.actions.map((action, index) => (
                    <button
                      className={
                        index === 0
                          ? 'admin-button admin-button-primary'
                          : 'admin-button admin-button-secondary'
                      }
                      data-testid={`apps-empty-${action.id}`}
                      key={action.id}
                      onClick={
                        action.id === 'browse-all'
                          ? () => setFilter('all')
                          : openCustomAppDialog
                      }
                      type="button"
                    >
                      {action.label}
                    </button>
                  ))}
                </div>
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
          ) : flatInstalled ? (
            <AppCategorySection
              expanded
              installed
              onToggleExpanded={() => {}}
              pageSize={pageSize}
              section={installedFlatShelf}
              standalone
            />
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
              they came for, not only after — but never *under* an empty grid,
              where the empty state above already offers it in the same words
              and the pair reads as a rendering fault. */}
          {empty ? null : (
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
          )}
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
