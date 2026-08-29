import { faPlus } from '@fortawesome/free-solid-svg-icons'
import type { AppCategory } from '@nessie/schemas'
import { useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { AppCard } from '../components/features/apps/AppCard'
import { AppCategorySection } from '../components/features/apps/AppCategorySection'
import { AppFeaturedStrip } from '../components/features/apps/AppFeaturedStrip'
import { AppCatalogueSkeleton } from '../components/features/apps/AppSkeletons'
import { AppsToolbar } from '../components/features/apps/AppsToolbar'
import {
  APP_GRID_CLASS,
  APP_GRID_FIVE_COLUMN_QUERY,
  APP_GRID_TWO_COLUMN_QUERY,
  CATALOGUE_FOOTER_NUDGE,
  appFilterOptions,
  appGridColumns,
  buildCategorySections,
  catalogueEmptyMessage,
  filterApps,
  parseAppFilter,
  sectionPageSize,
  type AppFilter,
} from '../components/features/apps/app-catalogue-view'
import {
  describeSearchResults,
  isAppSearchActive,
  searchResultsLabel,
} from '../components/features/apps/app-search'
import { AdminPageHeader } from '../components/shared/AdminPageHeader'
import { EmptyState } from '../components/shared/EmptyState'
import { useApps } from '../facades/apps/hooks'
import { useDebouncedValue } from '../hooks/useDebouncedValue'
import { registerViewportMediaQuery, useViewport } from '../hooks/useViewport'

/**
 * The Apps catalogue — the member's doorway to everything Nessie and its agents
 * can be connected to.
 *
 * It is a store, not an admin tool: one scrolling page of shelves, no protocol
 * vocabulary, and no network wait between a keystroke and a result. The whole
 * catalogue arrives in one request and every narrowing happens locally.
 *
 * The Connectors page (`/mcp-app-store`) stays the owner's surface for catalog
 * governance and the add-server wizard, and is where this page's one deliberate
 * doorway into protocol land leads.
 */

// The two widths the named breakpoint scale cannot express, registered once so
// the grid's column count in TS matches the columns CSS actually paints.
registerViewportMediaQuery('apps-grid-2col', APP_GRID_TWO_COLUMN_QUERY)
registerViewportMediaQuery('apps-grid-5col', APP_GRID_FIVE_COLUMN_QUERY)

const CONNECTORS_HREF = '/mcp-app-store'

export const AppsPage = () => {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const [query, setQuery] = useState('')
  const [expandedCategories, setExpandedCategories] = useState<Record<string, boolean>>({})
  const [activeCategory, setActiveCategory] = useState<AppCategory | null>(null)

  // 150 ms is below the threshold where typing feels laggy and above the rate
  // at which re-ranking 60 cards would churn.
  const debouncedQuery = useDebouncedValue(query, 150)
  const searching = isAppSearchActive(debouncedQuery)
  const filter = parseAppFilter(searchParams.get('filter'))
  // The query goes to the server: Postgres owns the weighted ranking and the
  // typo fallback, and a client-side re-filter would drop the rows only it can
  // find. `placeholderData` keeps the previous results painted while the next
  // ones arrive, so typing never flashes an empty shelf.
  const { data, isError, isPending } = useApps(
    searching ? { query: debouncedQuery } : {},
  )
  const viewport = useViewport()

  const columns = appGridColumns({
    twoColumns: viewport.media?.['apps-grid-2col'] ?? false,
    threeColumns: viewport.atLeast.md,
    fourColumns: viewport.atLeast.xl,
    fiveColumns: viewport.media?.['apps-grid-5col'] ?? false,
  })
  const pageSize = sectionPageSize(columns)

  const visibleApps = useMemo(() => filterApps(data?.apps ?? [], filter), [data, filter])
  const results = useMemo(
    () => (searching ? describeSearchResults(visibleApps, debouncedQuery) : []),
    [debouncedQuery, searching, visibleApps],
  )
  const sections = useMemo(
    () => (searching ? [] : buildCategorySections(visibleApps)),
    [searching, visibleApps],
  )
  const featured = useMemo(
    () => (searching ? [] : filterApps(data?.featured ?? [], filter)),
    [data, filter, searching],
  )

  const setFilter = (next: AppFilter) => {
    const params = new URLSearchParams(searchParams)
    if (next === 'all') params.delete('filter')
    else params.set('filter', next)
    setSearchParams(params, { replace: true })
  }

  const openConnectors = () => void navigate(CONNECTORS_HREF)

  const empty = searching ? results.length === 0 : sections.length === 0
  const emptyModel = catalogueEmptyMessage({
    filter,
    query: searching ? debouncedQuery : '',
    totalCount: data?.totalCount ?? 0,
  })

  return (
    <div className="flex h-full flex-col">
      <AdminPageHeader
        actions={[
          {
            icon: faPlus,
            id: 'apps-add-custom',
            label: 'Add custom MCP server',
            onSelect: openConnectors,
            primary: true,
            priority: 0,
          },
        ]}
        title="Apps"
        titleTone="page"
      />
      <div className="min-h-0 flex-1 overflow-y-auto bg-[color:var(--main)]">
        <div className="mx-auto w-full max-w-[80rem] px-4 py-6 sm:px-6 lg:px-8">
          <p className="mb-4 text-sm text-[color:var(--tx2)]">
            Connect Nessie and your agents to the tools your team uses.
          </p>

          <AppsToolbar
            activeCategory={activeCategory}
            filter={filter}
            filterOptions={appFilterOptions({
              installedCount: data?.installedCount ?? 0,
              totalCount: data?.totalCount ?? 0,
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
            <p
              className={[
                'mt-8 rounded-md border border-[color:var(--danger-border)]',
                'bg-[color:var(--danger-soft)] px-3 py-2 text-sm',
                'text-[color:var(--danger-text)]',
              ].join(' ')}
              data-testid="apps-load-error"
              role="alert"
            >
              We couldn&apos;t load the app catalogue. Refresh the page to try again.
            </p>
          ) : empty ? (
            <div className="mt-8" data-testid="apps-empty">
              <EmptyState>
                <p>{emptyModel.message}</p>
                <button
                  className="admin-button admin-button-secondary mt-3"
                  data-testid="apps-empty-add-custom"
                  onClick={openConnectors}
                  type="button"
                >
                  {emptyModel.actionLabel}
                </button>
              </EmptyState>
            </div>
          ) : searching ? (
            <div className="mt-6" data-testid="apps-search-results">
              <p className="mb-4 text-sm text-[color:var(--tx3)]">
                {searchResultsLabel(results.length, debouncedQuery)}
              </p>
              <div className={APP_GRID_CLASS}>
                {results.map((result) => (
                  <AppCard
                    app={result.app}
                    key={result.app.id}
                    provenance={result.provenance}
                    query={debouncedQuery}
                  />
                ))}
              </div>
            </div>
          ) : (
            <>
              <AppFeaturedStrip apps={featured} />
              {sections.map((section) => (
                <AppCategorySection
                  expanded={expandedCategories[section.category] === true}
                  key={section.category}
                  onToggleExpanded={() =>
                    setExpandedCategories((current) => ({
                      ...current,
                      [section.category]: current[section.category] !== true,
                    }))
                  }
                  pageSize={pageSize}
                  section={section}
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
                  onClick={openConnectors}
                  type="button"
                >
                  {CATALOGUE_FOOTER_NUDGE.actionLabel}
                </button>
              </div>
            </EmptyState>
          </div>
        </div>
      </div>
    </div>
  )
}
