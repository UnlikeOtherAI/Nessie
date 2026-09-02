import { useEffect, useMemo, useRef, useState } from 'react'
import type { Editor } from '@tiptap/react'
import { Popover } from '../../../overlays/Popover'
import { useDebouncedValue } from '../../../../hooks/useDebouncedValue'
import { useWikilinkSuggestions } from '../../../../facades/knowledge/wikilink-hooks'
import { INACTIVE_TRIGGER, wikilinkSuggestionKey } from './wikilink-suggestion'

const MENU_WIDTH = 280
const DEBOUNCE_MS = 200

type SuggestionItem =
  | { kind: 'page'; pageId: string; title: string }
  | { kind: 'create'; title: string }

// Live popup that opens while the cursor sits inside an unterminated `[[query`
// (tracked by the WikilinkSuggestion ProseMirror plugin). Renders debounced
// keyword-search hits plus a trailing "create new page" row, and owns all
// keyboard interaction (arrows/Enter/Escape) while open so the underlying
// editor's own keymap (which would otherwise insert a newline on Enter, say)
// never sees those keys.
export const WikilinkSuggestionMenu = ({ editor }: { editor: Editor }) => {
  const [trigger, setTrigger] = useState(() => wikilinkSuggestionKey.getState(editor.state) ?? INACTIVE_TRIGGER)
  const [dismissedFrom, setDismissedFrom] = useState<number | null>(null)
  const [activeIndex, setActiveIndex] = useState(0)
  // The editor's own DOM node stands in for a trigger element: a press inside
  // the text it is suggesting for is not an outside press.
  const editorRef = useRef<HTMLElement | null>(editor.view.dom as HTMLElement)
  editorRef.current = editor.view.dom as HTMLElement

  useEffect(() => {
    const handleTransaction = () => {
      setTrigger(wikilinkSuggestionKey.getState(editor.state) ?? INACTIVE_TRIGGER)
    }
    editor.on('transaction', handleTransaction)
    return () => {
      editor.off('transaction', handleTransaction)
    }
  }, [editor])

  useEffect(() => {
    if (!trigger.active) setDismissedFrom(null)
  }, [trigger.active])

  const open = trigger.active && trigger.from !== dismissedFrom
  const query = trigger.query.trim()
  const debouncedQuery = useDebouncedValue(query, DEBOUNCE_MS)

  useEffect(() => {
    setActiveIndex(0)
  }, [debouncedQuery, open])

  const { data: hits = [] } = useWikilinkSuggestions(debouncedQuery, open)

  const items = useMemo<SuggestionItem[]>(() => {
    const pageItems: SuggestionItem[] = hits.map((hit) => ({
      kind: 'page',
      pageId: hit.page.id,
      title: hit.page.title,
    }))
    if (query) pageItems.push({ kind: 'create', title: query })
    return pageItems
  }, [hits, query])

  const select = (item: SuggestionItem) => {
    const attrs =
      item.kind === 'page' ? { pageId: item.pageId, title: item.title } : { pageId: null, title: item.title }
    editor
      .chain()
      .focus()
      .insertContentAt({ from: trigger.from, to: trigger.to }, { type: 'kbWikilink', attrs })
      .run()
  }

  useEffect(() => {
    if (!open) return
    const dom = editor.view.dom
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        event.stopImmediatePropagation()
        setActiveIndex((index) => Math.min(index + 1, Math.max(items.length - 1, 0)))
      } else if (event.key === 'ArrowUp') {
        event.preventDefault()
        event.stopImmediatePropagation()
        setActiveIndex((index) => Math.max(index - 1, 0))
      } else if (event.key === 'Enter') {
        const item = items[activeIndex]
        if (item) {
          event.preventDefault()
          event.stopImmediatePropagation()
          select(item)
        }
      } else if (event.key === 'Escape') {
        event.preventDefault()
        event.stopImmediatePropagation()
        setDismissedFrom(trigger.from)
      }
    }
    dom.addEventListener('keydown', onKeyDown, true)
    return () => dom.removeEventListener('keydown', onKeyDown, true)
  }, [open, items, activeIndex, trigger.from, editor])

  if (!open) return null

  // The anchor is the caret, not an element: `coordsAtPos` gives its rect, and
  // placePopover flips the list above the line when the caret sits near the
  // bottom of the window and clamps it inside the horizontal gutter.
  const coords = editor.view.coordsAtPos(trigger.from)

  return (
    <Popover
      anchorRect={{
        bottom: coords.bottom,
        left: coords.left,
        right: coords.left,
        top: coords.top,
      }}
      anchorRef={editorRef}
      className="flex max-h-64 flex-col overflow-y-auto rounded-lg border border-[color:var(--sep)] bg-[color:var(--panel)] py-1 shadow-[0_16px_40px_var(--scrim-strong)]"
      label="Page suggestions"
      onClose={() => setDismissedFrom(trigger.from)}
      open
      placement="bottom-start"
      role="listbox"
      style={{ width: MENU_WIDTH }}
    >
      {items.length === 0 ? (
        <div className="px-3 py-2 text-xs text-[color:var(--tx3)]">
          {query ? 'Searching…' : 'Type to search pages…'}
        </div>
      ) : (
        items.map((item, index) => (
          <button
            className={[
              'w-full truncate px-3 py-1.5 text-left text-sm',
              index === activeIndex
                ? 'bg-[color:var(--accent)] text-[var(--on-accent)]'
                : 'text-[color:var(--tx2)] hover:bg-[var(--overlay-weak)] hover:text-[color:var(--tx)]',
            ].join(' ')}
            key={item.kind === 'page' ? item.pageId : `create:${item.title}`}
            // Keep the editor selection alive while clicking a suggestion.
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => select(item)}
            type="button"
          >
            {item.kind === 'page' ? item.title : `Link “${item.title}” (page doesn't exist yet)`}
          </button>
        ))
      )}
    </Popover>
  )
}
