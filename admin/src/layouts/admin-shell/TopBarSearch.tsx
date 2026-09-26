import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'

import { HighlightedText } from '../../components/features/search/HighlightedText'
import { SearchModeToggle } from '../../components/features/search/SearchModeToggle'
import {
  buildSearchResultItems,
  type SearchResultItem,
} from '../../components/features/search/search-result-items'
import { SearchResultMarker } from '../../components/features/search/SearchResultMarker'
import { useCurrentOrganization } from '../../facades/organization/hooks'
import {
  useGlobalSearch,
  usePersistedGlobalSearchMode,
} from '../../facades/search/hooks'

const SearchGlyph = () => (
  <svg fill="none" height="16" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" width="16">
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.5-3.5" strokeLinecap="round" />
  </svg>
)

type TopBarSearchProps = {
  autoFocus?: boolean
  onDismiss?: () => void
  variant?: 'topbar' | 'overlay'
}

/** Global grouped autocomplete, with one keyboard cursor across every section. */
export const TopBarSearch = ({
  autoFocus = false,
  onDismiss,
  variant = 'topbar',
}: TopBarSearchProps) => {
  const { t } = useTranslation('shell')
  const navigate = useNavigate()
  const { data: organization } = useCurrentOrganization()
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  // The overlay's mode stays a device preference rather than a `useTabParam`
  // host: it floats over the current route, so `?mode=` belongs only to /search.
  const [mode, setMode] = usePersistedGlobalSearchMode()
  const containerRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listboxId = useId()

  const results = useGlobalSearch(query, mode)
  const active = query.trim().length >= 2
  const items = useMemo(
    () => active
      ? buildSearchResultItems(results, results.appliedQuery, mode, { limitPerSection: 4 })
      : [],
    [active, mode, results],
  )

  useEffect(() => {
    setActiveIndex((current) => (current >= items.length ? 0 : current))
  }, [items.length])

  useEffect(() => {
    if (!autoFocus) return undefined
    const focusTimer = window.setTimeout(() => inputRef.current?.focus(), 0)
    return () => window.clearTimeout(focusTimer)
  }, [autoFocus])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        inputRef.current?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    if (!open) return undefined
    const onClick = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [open])

  const close = () => {
    setOpen(false)
    setQuery('')
    inputRef.current?.blur()
    onDismiss?.()
  }

  const fullSearchHref = () =>
    `/search?query=${encodeURIComponent(query.trim())}&mode=${mode}`

  const openItem = (item: SearchResultItem) => {
    navigate(item.href ?? fullSearchHref())
    close()
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      close()
      return
    }
    if (!open || items.length === 0) return
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActiveIndex((current) => (current + 1) % items.length)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveIndex((current) => (current - 1 + items.length) % items.length)
    } else if (event.key === 'Enter') {
      const item = items[activeIndex]
      if (item) {
        event.preventDefault()
        openItem(item)
      }
    }
  }

  const showDropdown = open && active
  let previousSection: string | null = null

  return (
    <div
      className={[
        'admin-topbar-search',
        variant === 'overlay' ? 'admin-topbar-search--overlay' : '',
      ].filter(Boolean).join(' ')}
      ref={containerRef}
    >
      <div className="admin-topbar-search-field">
        <span className="admin-topbar-search-icon"><SearchGlyph /></span>
        <input
          aria-activedescendant={
            showDropdown && items.length > 0 ? `${listboxId}-option-${activeIndex}` : undefined
          }
          aria-autocomplete="list"
          aria-controls={showDropdown ? listboxId : undefined}
          aria-expanded={showDropdown}
          aria-label={t('navigation.search')}
          className="admin-topbar-search-input"
          maxLength={200}
          onChange={(event) => {
            setQuery(event.target.value)
            setOpen(true)
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          placeholder={organization?.name
            ? t('search.placeholderNamed', { name: organization.name })
            : t('navigation.search')}
          ref={inputRef}
          role="combobox"
          type="search"
          value={query}
        />
      </div>
      <div
        className={['admin-topbar-search-toggle', open ? 'is-open' : '']
          .filter(Boolean)
          .join(' ')}
      >
        <SearchModeToggle compact mode={mode} onChange={setMode} />
      </div>

      {showDropdown ? (
        <div className="admin-topbar-results" id={listboxId} role="listbox">
          <p className="px-3 pb-2 pt-1 text-xs text-[color:var(--tx3)]">
            {mode === 'semantic'
              ? t('search.hybridDescription')
              : t('search.fullTextDescription')}
          </p>
          {results.errorMessage && items.length === 0 ? (
            <p className="px-3 py-4 text-sm text-[color:var(--danger)]">
              {results.errorMessage}
            </p>
          ) : items.length === 0 ? (
            <p className="px-3 py-4 text-sm text-[color:var(--tx3)]">
              {results.isLoading ? t('search.searching') : t('search.noResults')}
            </p>
          ) : (
            <>
              {results.errorMessage ? (
                <p className="px-3 pb-2 text-xs text-[color:var(--danger)]">
                  {t('search.partialError', { error: results.errorMessage })}
                </p>
              ) : null}
              {items.map((item, index) => {
                const showHeading = item.section !== previousSection
                previousSection = item.section
                return (
                  <div key={item.id} role="presentation">
                    {showHeading ? (
                      <p
                        className="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-[color:var(--tx3)]"
                        role="presentation"
                      >
                        {item.section}
                      </p>
                    ) : null}
                    <button
                      aria-selected={index === activeIndex}
                      className={[
                        'admin-topbar-result',
                        index === activeIndex ? 'is-active' : '',
                      ].join(' ')}
                      id={`${listboxId}-option-${index}`}
                      onClick={() => openItem(item)}
                      onMouseEnter={() => setActiveIndex(index)}
                      role="option"
                      type="button"
                    >
                      <SearchResultMarker size={28} subject={item.subject} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-[color:var(--tx)]">
                          <HighlightedText query={results.appliedQuery} text={item.primary} />
                        </span>
                        {item.secondary ? (
                          <span className="block truncate text-xs text-[color:var(--tx3)]">
                            <HighlightedText query={results.appliedQuery} text={item.secondary} />
                          </span>
                        ) : null}
                      </span>
                    </button>
                  </div>
                )
              })}
              <button
                className="admin-topbar-result justify-center text-xs font-medium text-[color:var(--accent)]"
                onClick={() => {
                  navigate(fullSearchHref())
                  close()
                }}
                type="button"
              >
                {t('search.seeAllResults')}
              </button>
            </>
          )}
        </div>
      ) : null}
    </div>
  )
}
