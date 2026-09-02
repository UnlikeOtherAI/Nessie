import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import type {
  ChannelRecord,
  MessageSearchResult,
  ProjectRecord,
  UserRecord,
} from '../../lib/api-client'
import { HighlightedPassage } from '../../components/features/search/HighlightedPassage'
import { SearchModeToggle } from '../../components/features/search/SearchModeToggle'
import { useCurrentOrganization } from '../../facades/organization/hooks'
import {
  useGlobalSearch,
  usePersistedGlobalSearchMode,
  type KnowledgeSearchHit,
  type ThoughtSearchHit,
} from '../../facades/search/hooks'
import { selectBestPassage } from '../../lib/highlight-passage'
import {
  SearchResultMarker,
  type SearchMarkerSubject,
} from '../../components/shared/SearchResultMarker'

// A single selectable entry in the flattened results list. Flattening lets the
// keyboard handler move a single cursor across every group in display order.
type ResultItem =
  | { kind: 'channel'; id: string; primary: string; secondary?: string; data: ChannelRecord }
  | { kind: 'person'; id: string; primary: string; secondary?: string; data: UserRecord }
  | { kind: 'project'; id: string; primary: string; secondary?: string; data: ProjectRecord }
  | { kind: 'message'; id: string; primary: string; secondary: string; data: MessageSearchResult }
  | {
      kind: 'knowledge'
      id: string
      primary: string
      secondary: ReactNode
      data: KnowledgeSearchHit
    }
  | { kind: 'thought'; id: string; primary: string; secondary: string; data: ThoughtSearchHit }

// The suggestion list and the full search page draw the same tile from the same
// hit, so the mapping into it lives beside the item type rather than in either
// surface's render.
const searchMarkerSubject = (item: ResultItem): SearchMarkerSubject => {
  if (item.kind === 'person') {
    return { kind: 'person', user: item.data, displayName: item.primary }
  }
  if (item.kind === 'project') {
    return { kind: 'project', project: item.data }
  }
  return { kind: item.kind }
}

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

// Centered search field with an inline, grouped results dropdown (command-palette
// style). Reuses the shared `useGlobalSearch` facade so results match the full
// Search page; adds keyboard navigation (↑/↓/Enter/Esc) and a ⌘K / Ctrl-K focus
// shortcut.
export const TopBarSearch = ({
  autoFocus = false,
  onDismiss,
  variant = 'topbar',
}: TopBarSearchProps) => {
  const navigate = useNavigate()
  const { data: organization } = useCurrentOrganization()
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const [mode, setMode] = usePersistedGlobalSearchMode()
  const containerRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const results = useGlobalSearch(query, mode)
  const active = query.trim().length >= 2

  const items = useMemo<ResultItem[]>(() => {
    if (!active) return []
    return [
      ...results.channels.map((c): ResultItem => ({
        kind: 'channel',
        id: `channel:${c.id}`,
        primary: c.label,
        secondary: c.projectName ?? undefined,
        data: c,
      })),
      ...results.people.map((p): ResultItem => ({
        kind: 'person',
        id: `person:${p.id}`,
        primary: p.displayName,
        secondary: p.email,
        data: p,
      })),
      ...results.projects.map((p): ResultItem => ({
        kind: 'project',
        id: `project:${p.id}`,
        primary: p.name,
        data: p,
      })),
      ...results.messages.map((m): ResultItem => ({
        kind: 'message',
        id: `message:${m.id}`,
        primary: m.snippet,
        secondary: `${m.authorName} · ${m.channelLabel}`,
        data: m,
      })),
      ...results.knowledge.map((k): ResultItem => {
        const bestPassage = selectBestPassage(k.passages)
        return {
          kind: 'knowledge',
          id: `knowledge:${k.page.id}`,
          primary: k.page.title,
          // hit.score is ranking metadata only and is never rendered.
          secondary: bestPassage ? (
            <HighlightedPassage passage={bestPassage.content} query={query} />
          ) : (
            k.snippet
          ),
          data: k,
        }
      }),
      ...results.thoughts.map((thought): ResultItem => ({
        kind: 'thought',
        id: `thought:${thought.id}`,
        primary: thought.content,
        secondary: `Memory - ${Math.round(thought.similarity * 100)}% semantic match`,
        data: thought,
      })),
    ]
  }, [active, query, results])

  // Clamp the active row whenever the result set changes.
  useEffect(() => {
    setActiveIndex((current) => (current >= items.length ? 0 : current))
  }, [items.length])

  useEffect(() => {
    if (!autoFocus) return undefined
    const focusTimer = window.setTimeout(() => inputRef.current?.focus(), 0)
    return () => window.clearTimeout(focusTimer)
  }, [autoFocus])

  // ⌘K / Ctrl-K focuses the search from anywhere.
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

  // Close on a click outside the search container.
  useEffect(() => {
    if (!open) return
    const onClick = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) {
        setOpen(false)
      }
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

  const openItem = (item: ResultItem) => {
    switch (item.kind) {
      case 'channel':
        navigate(`/channels/${item.data.id}`)
        break
      case 'person': {
        const dm = item.data.channelIds.find((id) => id.length > 0)
        navigate(dm ? `/channels/${dm}` : '/channels')
        break
      }
      case 'project':
        navigate(`/projects/${item.data.id}`)
        break
      case 'message':
        navigate(`/channels/${item.data.channelId}`)
        break
      case 'knowledge':
        navigate(`/knowledge-base?spaceId=${item.data.page.spaceId}&pageId=${item.data.page.id}`)
        break
      case 'thought':
        navigate(`/search?query=${encodeURIComponent(query.trim())}&mode=semantic`)
        break
    }
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

  return (
    <div
      className={[
        'admin-topbar-search',
        variant === 'overlay' ? 'admin-topbar-search--overlay' : '',
      ].filter(Boolean).join(' ')}
      ref={containerRef}
    >
      <div className="admin-topbar-search-field">
        <span className="admin-topbar-search-icon">
          <SearchGlyph />
        </span>
        <input
          className="admin-topbar-search-input"
          onChange={(event) => {
            setQuery(event.target.value)
            setOpen(true)
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          placeholder={organization?.name ? `Search ${organization.name}` : 'Search'}
          ref={inputRef}
          type="text"
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
        <div className="admin-topbar-results" role="listbox">
          {mode === 'semantic' ? (
            <p className="px-3 pb-2 pt-1 text-xs text-[color:var(--tx3)]">
              Semantic searches memory and knowledge by meaning. Messages stay in Text mode.
            </p>
          ) : null}
          {results.errorMessage ? (
            <p className="px-3 py-4 text-sm text-[color:var(--danger)]">
              {results.errorMessage}
            </p>
          ) : items.length === 0 ? (
            <p className="px-3 py-4 text-sm text-[color:var(--tx3)]">
              {results.isLoading ? 'Searching…' : 'No results'}
            </p>
          ) : (
            items.map((item, index) => (
              <button
                aria-selected={index === activeIndex}
                className={[
                  'admin-topbar-result',
                  index === activeIndex ? 'is-active' : '',
                ].join(' ')}
                key={item.id}
                onClick={() => openItem(item)}
                onMouseEnter={() => setActiveIndex(index)}
                role="option"
                type="button"
              >
                <SearchResultMarker size={28} subject={searchMarkerSubject(item)} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-[color:var(--tx)]">
                    {item.primary}
                  </span>
                  {item.secondary ? (
                    <span className="block truncate text-xs text-[color:var(--tx3)]">
                      {item.secondary}
                    </span>
                  ) : null}
                </span>
              </button>
            ))
          )}
        </div>
      ) : null}
    </div>
  )
}
