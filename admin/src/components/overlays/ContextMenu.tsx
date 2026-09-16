import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode, RefObject } from 'react'
import type { IconDefinition } from '@fortawesome/fontawesome-svg-core'
import { faCheck } from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { useViewport } from '../../hooks/useViewport'
import { useNavigationLayout } from '../../navigation/mobile-shell'
import { shortcutLabel } from '../../lib/platform'
import { Popover } from './Popover'
import { Sheet } from './Sheet'
import type { ContextMenuAnchor } from './useContextMenu'

/**
 * The admin's right-click menu — the one kind of overlay it did not have.
 *
 * It is a composition, not a fifth overlay kind: `Popover role="menu"` on
 * `split` and `Sheet side="bottom"` on `single`, decided by
 * `useNavigationLayout()` and never by a width. Both primitives compose
 * `useOverlay`, so the layer, the Back registration and Escape are theirs
 * (docs/navigation/overview.md §7) and nothing here restates them — in
 * particular there is no third private flip routine: a pointer anchor is a
 * zero-size rect handed to `Popover`, which places it through the one
 * `placePopover`.
 *
 * What this file *does* own is the menu-button pattern the primitives
 * deliberately leave out: a menu is the one popover role that takes focus, so
 * focus moves to the first enabled item on open, rolls with ↑/↓, Home/End and
 * type-ahead, and returns to the row on close.
 */

export type ContextMenuItem =
  | {
      kind: 'item'
      id: string
      label: string
      icon?: IconDefinition
      shortcut?: string
      disabled?: boolean
      // Why it is greyed. Offering an edit the server will refuse is the
      // failure; saying why it is unavailable is the cure.
      disabledReason?: string
      destructive?: boolean
      onSelect: () => void
    }
  | { kind: 'radio'; id: string; label: string; checked: boolean; onSelect: () => void }
  | { kind: 'separator' }
  // A non-interactive caption — the access read-out line.
  | { kind: 'heading'; label: string }

type ActionItem = Extract<ContextMenuItem, { kind: 'item' } | { kind: 'radio' }>

type ContextMenuProps = {
  // null = closed.
  anchor: ContextMenuAnchor | null
  items: ContextMenuItem[]
  // The accessible name, e.g. "Actions for Lease.pdf".
  label: string
  onClose: () => void
  // Focus returns here on close: the row that opened the menu.
  returnFocusRef: RefObject<HTMLElement | null>
  // Where focus goes when that row is gone (it was just deleted) — the column
  // body. Without it, focus would fall to the document and the keyboard walk
  // would start over at the top of the page.
  fallbackFocusRef?: RefObject<HTMLElement | null>
  // A menu opened over a Dialog sits above it and closes first. Nothing does
  // this today; the seam exists so the answer is not a literal z-index.
  layer?: 'popover' | 'modal'
}

const PANEL_CLASS =
  'min-w-[220px] overflow-y-auto rounded-[var(--radius-md)] border border-[color:var(--sep)]'
  + ' bg-[color:var(--panel)] py-1 shadow-[0_16px_40px_var(--scrim-strong)]'

// The bottom sheet is the same list on its own surface. It carries a top
// border and top corners only: a bordered box inside a bordered box is the
// nesting the design system forbids, and the sheet is already the edge.
const SHEET_CLASS =
  'max-h-[70vh] overflow-y-auto rounded-t-[var(--radius-lg)] border-t border-[color:var(--sep)]'
  + ' bg-[color:var(--panel)] py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]'

const isAction = (item: ContextMenuItem): item is ActionItem =>
  item.kind === 'item' || item.kind === 'radio'

const isEnabled = (item: ActionItem): boolean => item.kind === 'radio' || !item.disabled

// Hover and focus paint is withheld in JS rather than with a `:not(...)`
// guard on a CSS rule. The admin's unlayered `button { font: inherit }` reset
// is the standing proof that an unlayered rule outranks a layered utility, so
// a disabled control that carries no hover class at all cannot be repainted by
// one — and the same reason puts every text size on an inner span, never on
// the button, where `font: inherit` would silently swallow it.
const itemClass = (options: {
  coarsePointer: boolean
  destructive: boolean
  disabled: boolean
}): string =>
  [
    'group flex w-full items-center gap-3 px-3 text-left outline-none',
    options.coarsePointer ? 'min-h-[44px]' : 'min-h-[36px]',
    options.disabled
      ? 'cursor-default text-[color:var(--tx)] opacity-50'
      : options.destructive
        ? 'text-[color:var(--danger-text)] hover:bg-[color:var(--danger)]'
          + ' hover:text-[color:var(--on-accent)] focus:bg-[color:var(--danger)]'
          + ' focus:text-[color:var(--on-accent)]'
        : 'text-[color:var(--tx)] hover:bg-[color:var(--accent)]'
          + ' hover:text-[color:var(--on-accent)] focus:bg-[color:var(--accent)]'
          + ' focus:text-[color:var(--on-accent)]',
  ].join(' ')

const subtleClass = (disabled: boolean): string =>
  disabled
    ? 'text-[color:var(--tx3)]'
    : 'text-[color:var(--tx3)] group-hover:text-[color:var(--on-accent)]'
      + ' group-focus:text-[color:var(--on-accent)]'

const TYPE_AHEAD_RESET_MS = 1_000

export const ContextMenu = ({
  anchor,
  items,
  label,
  onClose,
  returnFocusRef,
  fallbackFocusRef,
  layer = 'popover',
}: ContextMenuProps) => {
  const layout = useNavigationLayout()
  const { capabilities: { coarsePointer } } = useViewport()
  const open = anchor !== null

  const actions = useMemo(() => items.filter(isAction), [items])
  const firstEnabledId = actions.find(isEnabled)?.id ?? actions[0]?.id ?? null
  const firstEnabledIdRef = useRef(firstEnabledId)
  firstEnabledIdRef.current = firstEnabledId

  const [activeId, setActiveId] = useState<string | null>(firstEnabledId)
  const activeIdRef = useRef(activeId)
  activeIdRef.current = activeId

  const nodes = useRef(new Map<string, HTMLButtonElement>())
  const firstEnabledNode = useRef<HTMLButtonElement | null>(null)
  const typed = useRef({ at: 0, buffer: '' })

  // The panel leaves the page tree, so the last pointer anchor is kept for the
  // close motion: the menu would otherwise jump to 0,0 as it fades.
  const lastAnchor = useRef<ContextMenuAnchor | null>(anchor)
  if (anchor) lastAnchor.current = anchor
  const placedAnchor = anchor ?? lastAnchor.current
  // A pointer anchor has no element behind it; the ref is real so `Popover`'s
  // outside-press check has something stable to ask.
  const pointAnchorRef = useRef<HTMLElement | null>(null)

  const focusItem = useCallback((id: string | null) => {
    if (id) nodes.current.get(id)?.focus()
  }, [])

  // Whether the close left focus with nobody. A menu that closes because the
  // person pressed something else has already given focus away, and restoring
  // over the top of that would take them back to where they no longer are —
  // but a menu that closes on Escape, on Tab or on one of its own items drops
  // the focused item out of the document, and focus falls to the body. That
  // fall is what this catches: by the time the close has committed the items
  // are usually already detached, so "is focus still on an item" is the wrong
  // question and answering it was how the row silently lost its place.
  const focusIsUnclaimed = useCallback((): boolean => {
    if (typeof document === 'undefined') return false
    const active = document.activeElement
    if (active === null || active === document.body) return true
    for (const node of nodes.current.values()) {
      if (node === active) return true
    }
    return false
  }, [])

  // Read through a ref so the open effect's cleanup — which is the close — does
  // not re-run every time a call site rebuilds `returnFocusRef`'s owner.
  const restoreFocus = useRef<() => void>(() => undefined)
  restoreFocus.current = () => {
    if (!focusIsUnclaimed()) return
    const row = returnFocusRef.current
    const target = row?.isConnected ? row : fallbackFocusRef?.current ?? null
    target?.focus()
  }

  useEffect(() => {
    if (open) setActiveId(firstEnabledIdRef.current)
  }, [open])

  // On `single` the Sheet traps focus and restores it on close (useModalA11y,
  // through useOverlay), so this owns focus on the popover path only and hands
  // the sheet its first item as `initialFocusRef` instead.
  useEffect(() => {
    if (!open || layout === 'single') return undefined
    // `Popover` lays the panel out unpainted until its first measurement, and
    // a `visibility: hidden` element cannot take focus. One turn of the timer
    // loop lands after it, the same way `AssigneePicker` focuses its search.
    const timer = window.setTimeout(() => focusItem(activeIdRef.current), 0)
    return () => {
      window.clearTimeout(timer)
      restoreFocus.current()
    }
  }, [focusItem, layout, open])

  const activate = useCallback(
    (item: ActionItem) => {
      if (item.kind === 'item' && item.disabled) return
      // Closed first, so the focus restore below runs before whatever the item
      // opens takes focus for itself — React runs a commit's cleanups before
      // its mounts, which is exactly the order a dialog needs.
      onClose()
      item.onSelect()
    },
    [onClose],
  )

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLElement>) => {
      const ids = actions.map((item) => item.id)
      if (ids.length === 0) return
      const current = Math.max(0, ids.indexOf(activeIdRef.current ?? ids[0] ?? ''))
      const moveTo = (index: number) => {
        event.preventDefault()
        const id = ids[((index % ids.length) + ids.length) % ids.length] ?? null
        setActiveId(id)
        focusItem(id)
      }
      switch (event.key) {
        case 'ArrowDown':
          return moveTo(current + 1)
        case 'ArrowUp':
          return moveTo(current - 1)
        case 'Home':
          return moveTo(0)
        case 'End':
          return moveTo(ids.length - 1)
        case 'Tab':
          // A menu is not a tab stop: Tab closes it and gives the row back.
          event.preventDefault()
          onClose()
          return
        default:
          break
      }
      // Escape is deliberately absent: `useOverlay` owns it for both the
      // popover and the sheet, and handling it here would close twice.
      if (event.key.length !== 1 || event.metaKey || event.ctrlKey || event.altKey) return
      const now = Date.now()
      typed.current.buffer = now - typed.current.at > TYPE_AHEAD_RESET_MS ? '' : typed.current.buffer
      typed.current.at = now
      typed.current.buffer += event.key.toLowerCase()
      const rotated = actions.map(
        (_, offset) => actions[(current + 1 + offset) % actions.length] as ActionItem,
      )
      const match = rotated.find((item) =>
        item.label.toLowerCase().startsWith(typed.current.buffer),
      )
      if (!match) return
      event.preventDefault()
      setActiveId(match.id)
      focusItem(match.id)
    },
    [actions, focusItem, onClose],
  )

  const showShortcuts = layout === 'split' && !coarsePointer

  const renderItem = (item: ContextMenuItem, index: number): ReactNode => {
    if (item.kind === 'separator') {
      return <div className="my-1 h-px bg-[color:var(--sep)]" key={`sep-${index}`} role="separator" />
    }
    if (item.kind === 'heading') {
      return (
        <div
          className="px-3 py-1.5 text-xs text-[color:var(--tx3)]"
          key={`heading-${index}`}
          role="presentation"
        >
          {item.label}
        </div>
      )
    }
    const disabled = item.kind === 'item' && item.disabled === true
    const icon = item.kind === 'radio' ? (item.checked ? faCheck : undefined) : item.icon
    return (
      <button
        aria-checked={item.kind === 'radio' ? item.checked : undefined}
        // Never the `disabled` attribute: a keyboard user has to be able to
        // land on it to hear why it is unavailable.
        aria-disabled={disabled ? true : undefined}
        className={itemClass({ coarsePointer, destructive: item.kind === 'item' && item.destructive === true, disabled })}
        key={item.id}
        onClick={() => activate(item)}
        ref={(node) => {
          if (node) nodes.current.set(item.id, node)
          else nodes.current.delete(item.id)
          if (item.id === firstEnabledId) firstEnabledNode.current = node
        }}
        role={item.kind === 'radio' ? 'menuitemradio' : 'menuitem'}
        tabIndex={item.id === activeId ? 0 : -1}
        title={disabled && item.kind === 'item' ? item.disabledReason : undefined}
        type="button"
      >
        <span className={`w-4 shrink-0 ${subtleClass(disabled)}`}>
          {icon ? <FontAwesomeIcon className="h-4 w-4" icon={icon} /> : null}
        </span>
        <span className="min-w-0 flex-1 truncate text-sm">{item.label}</span>
        {item.kind === 'item' && item.shortcut && showShortcuts ? (
          <span className={`shrink-0 text-xs ${subtleClass(disabled)}`}>
            {shortcutLabel(item.shortcut)}
          </span>
        ) : null}
      </button>
    )
  }

  const body = items.map(renderItem)

  if (layout === 'single') {
    return (
      <Sheet
        initialFocusRef={firstEnabledNode}
        onClose={onClose}
        open={open}
        side="bottom"
        size="auto"
        title={label}
      >
        <div aria-label={label} className={SHEET_CLASS} onKeyDown={onKeyDown} role="menu">
          {body}
        </div>
      </Sheet>
    )
  }

  return (
    <Popover
      anchorRef={placedAnchor?.kind === 'element' ? placedAnchor.ref : pointAnchorRef}
      anchorRect={
        placedAnchor?.kind === 'point'
          ? {
              bottom: placedAnchor.y,
              left: placedAnchor.x,
              right: placedAnchor.x,
              top: placedAnchor.y,
            }
          : null
      }
      className={PANEL_CLASS}
      label={label}
      layer={layer}
      onClose={onClose}
      onKeyDown={onKeyDown}
      open={open}
      placement="bottom-start"
      role="menu"
    >
      {body}
    </Popover>
  )
}
