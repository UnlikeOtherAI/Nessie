import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type {
  ChannelRecord,
  MessageSearchResult,
  ProjectRecord,
  UserRecord,
} from '../../lib/api-client'
import { useCurrentOrganization } from '../../facades/organization/hooks'
import { useGlobalSearch, type KnowledgeSearchHit } from '../../facades/search/hooks'

// A single selectable entry in the flattened results list. Flattening lets the
// keyboard handler move a single cursor across every group in display order.
type ResultItem =
  | { kind: 'channel'; id: string; primary: string; secondary?: string; data: ChannelRecord }
  | { kind: 'person'; id: string; primary: string; secondary?: string; data: UserRecord }
  | { kind: 'project'; id: string; primary: string; secondary?: string; data: ProjectRecord }
  | { kind: 'message'; id: string; primary: string; secondary: string; data: MessageSearchResult }
  | { kind: 'knowledge'; id: string; primary: string; secondary: string; data: KnowledgeSearchHit }

const SearchGlyph = () => (
  <svg fill="none" height="16" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" width="16">
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.5-3.5" strokeLinecap="round" />
  </svg>
)

const markerClass = [
  'flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md',
  'bg-[color:var(--overlay-weak)] text-[12px] font-semibold text-[color:var(--tx2)]',
].join(' ')

const initial = (value: string): string => value.trim().charAt(0).toUpperCase() || '?'

// Centered search field with an inline, grouped results dropdown (command-palette
// style). Reuses the shared `useGlobalSearch` facade so results match the full
// Search page; adds keyboard navigation (↑/↓/Enter/Esc) and a ⌘K / Ctrl-K focus
// shortcut.
export const TopBarSearch = () => {
  const navigate = useNavigate()
  const { data: organization } = useCurrentOrganization()
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const containerRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const results = useGlobalSearch(query)
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
      ...results.knowledge.map((k): ResultItem => ({
        kind: 'knowledge',
        id: `knowledge:${k.page.id}`,
        primary: k.page.title,
        secondary: k.snippet,
        data: k,
      })),
    ]
  }, [active, results])

  // Clamp the active row whenever the result set changes.
  useEffect(() => {
    setActiveIndex((current) => (current >= items.length ? 0 : current))
  }, [items.length])

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
        navigate('/knowledge-base')
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
    <div className="admin-topbar-search" ref={containerRef}>
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

      {showDropdown ? (
        <div className="admin-topbar-results" role="listbox">
          {items.length === 0 ? (
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
                <span className={markerClass}>
                  {item.kind === 'channel'
                    ? '#'
                    : item.kind === 'message'
                      ? '💬'
                      : item.kind === 'knowledge'
                        ? '📄'
                        : initial(item.primary)}
                </span>
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
