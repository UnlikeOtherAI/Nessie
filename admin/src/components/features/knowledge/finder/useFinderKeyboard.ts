import { useCallback, useRef } from 'react'
import type { KeyboardEvent } from 'react'
import type { FinderSelectionEvent } from './finder-selection'

/**
 * The Finder's key table (browser-ui.md §7), as one handler a column puts on
 * its rows. A column owns its own order and its own "what does → do here", so
 * the hook takes them rather than reaching for them.
 *
 * Space is deliberately unbound: Quick Look is out of scope, and reassigning
 * the key a person's fingers already expect to preview with is worse than
 * leaving it inert.
 */

export type FinderKeyboardInput = {
  columnKey: string
  /** The column's rows, in the order they are drawn. */
  order: readonly string[]
  /** True for a row that can be opened as a column. */
  isFolder: (id: string) => boolean
  dispatch: (event: FinderSelectionEvent) => void
  onOpen: (id: string) => void
  /** ← at column 0 does nothing; deeper it returns to the parent column. */
  onBack?: () => void
  onDelete?: (ids: readonly string[]) => void
  onGetInfo?: (ids: readonly string[]) => void
  onNewFolder?: () => void
  onRename?: (id: string) => void
  /** Wave 2's menu: Shift+F10 and the Menu key open it on the focused row. */
  onContextMenu?: (id: string) => void
  selectedIds: readonly string[]
  /** Titles by id, for type-ahead. */
  titleOf: (id: string) => string
}

/** How long a type-ahead buffer survives without another keystroke. */
const TYPE_AHEAD_MS = 700

// Which key is "the" modifier here. Deliberately local and deliberately
// small: `lib/platform.ts` is another agent's file this wave, and a two-line
// duplicate is cheaper than a dependency edge between two waves. Fold it into
// that module when both have landed.
const usesCommandKey = (): boolean =>
  typeof navigator !== 'undefined' && /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent)

export const useFinderKeyboard = ({
  columnKey,
  dispatch,
  isFolder,
  onBack,
  onContextMenu,
  onDelete,
  onGetInfo,
  onNewFolder,
  onOpen,
  onRename,
  order,
  selectedIds,
  titleOf,
}: FinderKeyboardInput) => {
  const buffer = useRef({ at: 0, text: '' })

  return useCallback(
    (event: KeyboardEvent<HTMLElement>, id: string): void => {
      const accelerator = usesCommandKey() ? event.metaKey : event.ctrlKey
      const step = (value: number | 'home' | 'end') => {
        event.preventDefault()
        dispatch({ columnKey, extend: event.shiftKey, order, step: value, type: 'step' })
      }

      switch (event.key) {
        case 'ArrowDown':
          return step(1)
        case 'ArrowUp':
          return step(-1)
        case 'Home':
          return step('home')
        case 'End':
          return step('end')
        case 'ArrowRight':
          if (!isFolder(id)) return
          event.preventDefault()
          return onOpen(id)
        case 'ArrowLeft':
          if (!onBack) return
          event.preventDefault()
          return onBack()
        case 'Enter':
          event.preventDefault()
          return onOpen(id)
        case 'F2':
          if (!onRename) return
          event.preventDefault()
          return onRename(id)
        case 'Delete':
        case 'Backspace':
          if (!onDelete) return
          event.preventDefault()
          return onDelete(selectedIds.length > 0 ? selectedIds : [id])
        case 'F10':
          if (!event.shiftKey || !onContextMenu) return
          event.preventDefault()
          return onContextMenu(id)
        case 'ContextMenu':
          if (!onContextMenu) return
          event.preventDefault()
          return onContextMenu(id)
        case 'Escape':
          // The overlay layer takes Escape first and closes an open menu; by
          // the time it reaches a row there is nothing open to close.
          event.preventDefault()
          return dispatch({ type: 'clear' })
        default:
          break
      }

      if (accelerator && (event.key === 'a' || event.key === 'A')) {
        event.preventDefault()
        return dispatch({ columnKey, order, type: 'selectAll' })
      }
      if (accelerator && (event.key === 'i' || event.key === 'I') && onGetInfo) {
        event.preventDefault()
        return onGetInfo(selectedIds.length > 0 ? selectedIds : [id])
      }
      if (accelerator && event.shiftKey && (event.key === 'n' || event.key === 'N') && onNewFolder) {
        event.preventDefault()
        return onNewFolder()
      }

      // Type-ahead. One printable character, no modifiers: a buffer that
      // accepted Cmd-combinations would swallow every shortcut above it.
      if (accelerator || event.altKey || event.key.length !== 1) return
      const now = Date.now()
      buffer.current = {
        at: now,
        text: (now - buffer.current.at > TYPE_AHEAD_MS ? '' : buffer.current.text)
          + event.key.toLowerCase(),
      }
      const match = order.find((candidate) =>
        titleOf(candidate).toLowerCase().startsWith(buffer.current.text),
      )
      if (!match) return
      event.preventDefault()
      dispatch({ columnKey, id: match, modifier: 'none', order, type: 'click' })
    },
    [
      columnKey,
      dispatch,
      isFolder,
      onBack,
      onContextMenu,
      onDelete,
      onGetInfo,
      onNewFolder,
      onOpen,
      onRename,
      order,
      selectedIds,
      titleOf,
    ],
  )
}
