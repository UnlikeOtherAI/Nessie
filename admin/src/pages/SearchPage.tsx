import { useMemo, useState, type ReactNode } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'

import { HighlightedText } from '../components/features/search/HighlightedText'
import { SearchModeToggle } from '../components/features/search/SearchModeToggle'
import {
  buildSearchResultItems,
  SEARCH_SECTION_ORDER,
  type SearchResultItem,
  type SearchSectionTitle,
} from '../components/features/search/search-result-items'
import { SearchResultMarker } from '../components/features/search/SearchResultMarker'
import { PaginationFooter } from '../components/shared/PaginationFooter'
import { ScreenHeader } from '../components/shared/ScreenHeader'
import { SectionLabel } from '../components/primitives/SectionLabel'
import {
  GLOBAL_SEARCH_MODES,
  readStoredSearchMode,
  useGlobalSearch,
  writeStoredSearchMode,
} from '../facades/search/hooks'
import { useTabParam } from '../navigation/useTabParam'

const rowClass = [
  'flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left',
  'transition-colors hover:bg-[color:var(--overlay-weak)]',
].join(' ')

interface SearchResultRowProps {
  item: SearchResultItem
  query: string
  onClick?: () => void
}

const SearchResultRow = ({ item, query, onClick }: SearchResultRowProps) => {
  const content = (
    <>
      <SearchResultMarker size={32} subject={item.subject} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-[color:var(--tx)]">
          <HighlightedText query={query} text={item.primary} />
        </span>
        {item.secondary ? (
          <span className="block truncate text-xs text-[color:var(--tx3)]">
            <HighlightedText query={query} text={item.secondary} />
          </span>
        ) : null}
      </span>
    </>
  )

  return onClick ? (
    <button className={rowClass} onClick={onClick} type="button">{content}</button>
  ) : (
    <div className={rowClass}>{content}</div>
  )
}

const SearchSection = ({
  children,
  title,
}: {
  children: ReactNode
  title: SearchSectionTitle
}) => (
  <section className="space-y-1">
    <SectionLabel as="h2" className="px-3">{title}</SectionLabel>
    <div className="space-y-0.5">{children}</div>
  </section>
)

export const SearchPage = () => {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  // `?mode=` is state of this Search surface. A legacy `text` value becomes
  // full-text search; a missing value uses the stored choice.
  const [storedMode] = useState(readStoredSearchMode)
  const fallbackMode = searchParams.get('mode') === 'text' ? 'fulltext' : storedMode
  const [mode, selectMode] = useTabParam('mode', GLOBAL_SEARCH_MODES, fallbackMode)
  const query = (searchParams.get('query') ?? '').slice(0, 200)
  const results = useGlobalSearch(query, mode)
  const active = query.trim().length >= 2
  const items = useMemo(
    () => buildSearchResultItems(results, results.appliedQuery, mode),
    [mode, results],
  )
  const itemsBySection = useMemo(() => {
    const grouped = new Map<SearchSectionTitle, SearchResultItem[]>()
    for (const item of items) {
      const group = grouped.get(item.section) ?? []
      group.push(item)
      grouped.set(item.section, group)
    }
    return grouped
  }, [items])

  const hasTaskPage = mode === 'fulltext'
    && active
    && !results.taskPagination.query.isError
    && (
      results.tasks.length > 0
      || results.taskPagination.page > 0
      || results.taskPagination.canNext
    )
  const hasResults = items.length > 0 || hasTaskPage

  const updateQuery = (nextQuery: string) => {
    const next = new URLSearchParams(searchParams)
    if (nextQuery.trim()) next.set('query', nextQuery)
    else next.delete('query')
    setSearchParams(next, { replace: true })
  }

  const updateMode = (nextMode: typeof mode) => {
    writeStoredSearchMode(nextMode)
    selectMode(nextMode)
  }

  return (
    <section className="flex h-full min-h-0 flex-col">
      <ScreenHeader title="Search" />

      <div className="flex min-h-0 flex-1 flex-col">
        <div className="border-b border-[color:var(--sep)] px-[var(--page-gutter)] py-5">
          <div className="flex flex-col gap-3 md:flex-row md:items-center">
            <input
              autoFocus
              className="admin-input min-w-0 flex-1"
              maxLength={200}
              onChange={(event) => updateQuery(event.target.value)}
              placeholder="Search channels, projects, tickets, messages, documents, people, agents, apps, and memory…"
              type="search"
              value={query}
            />
            <SearchModeToggle mode={mode} onChange={updateMode} />
          </div>
          <p className="mt-3 text-xs text-[color:var(--tx3)]">
            {mode === 'semantic'
              ? 'Hybrid search keeps full-text matches and adds meaning-based results where content has embeddings.'
              : 'Full text finds the words you entered, without meaning-based expansion.'}
          </p>
        </div>

        <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-[var(--page-gutter)] py-5">
          {!active ? (
            <p className="px-3 text-sm text-[color:var(--tx3)]">
              Enter at least two characters to search every section.
            </p>
          ) : results.isLoading && !hasResults ? (
            <p className="px-3 text-sm text-[color:var(--tx3)]">Searching…</p>
          ) : !hasResults ? (
            results.invalidTaskCursor ? (
              <p className="px-3 text-sm text-[color:var(--danger-text)]">
                This ticket-search page expired.{' '}
                <button className="admin-link" onClick={results.restartTaskSearch} type="button">
                  Restart ticket search
                </button>
              </p>
            ) : results.errorMessage ? (
              <p className="px-3 text-sm text-[color:var(--danger-text)]">
                {results.errorMessage}
              </p>
            ) : (
              <p className="px-3 text-sm text-[color:var(--tx3)]">No results</p>
            )
          ) : (
            <>
              {results.invalidTaskCursor ? (
                <p className="px-3 text-sm text-[color:var(--danger-text)]">
                  This ticket-search page expired.{' '}
                  <button className="admin-link" onClick={results.restartTaskSearch} type="button">
                    Restart ticket search
                  </button>
                </p>
              ) : results.errorMessage ? (
                <p className="px-3 text-sm text-[color:var(--danger-text)]">
                  {results.errorMessage}
                </p>
              ) : null}

              {SEARCH_SECTION_ORDER.map((section) => {
                const sectionItems = itemsBySection.get(section) ?? []
                if (sectionItems.length === 0 && !(section === 'Tickets' && hasTaskPage)) {
                  return null
                }
                return (
                  <SearchSection key={section} title={section}>
                    {sectionItems.map((item) => {
                      const href = item.href
                      return (
                        <SearchResultRow
                          item={item}
                          key={item.id}
                          onClick={href ? () => navigate(href) : undefined}
                          query={results.appliedQuery}
                        />
                      )
                    })}
                    {section === 'Tickets' && hasTaskPage ? (
                      <>
                        {results.tasks.length === 0 ? (
                          <p className="px-3 py-2 text-sm text-[color:var(--tx3)]">
                            No ticket results on this page.
                          </p>
                        ) : null}
                        <PaginationFooter
                          canNext={results.taskPagination.canNext}
                          canPrevious={results.taskPagination.canPrevious}
                          className="mx-3"
                          hideWhenSinglePage
                          label={results.taskPagination.label}
                          onPageChange={results.taskPagination.onPageChange}
                          onPageSizeChange={results.taskPagination.onPageSizeChange}
                          page={results.taskPagination.page}
                          pageCount={results.taskPagination.pageCount}
                          pageSize={results.taskPagination.pageSize}
                        />
                      </>
                    ) : null}
                  </SearchSection>
                )
              })}
            </>
          )}
        </div>
      </div>
    </section>
  )
}
