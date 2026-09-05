import { faChevronDown } from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { haptic } from '../../lib/haptics'
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import { Popover } from '../overlays/Popover'
import { decideTabBarCollapse } from './tab-bar-fit'

export type TabBarItem<T extends string> = {
  /** Rendered as a dimmed `(n)` after the label — the distribution at a glance. */
  count?: number
  /** A radio-style choice that is currently unavailable. */
  disabled?: boolean
  icon?: ReactNode
  label: string
  testId?: string
  /** Native tooltip, for a strip whose labels need a sentence of explanation. */
  title?: string
  value: T
}

type TabBarProps<T extends string> = {
  ariaLabel: string
  /**
   * What the strip does when its items no longer fit the width it is given.
   * `auto` (the default) swaps the whole strip for a dropdown showing the
   * selected item; `never` keeps the strip and lets it scroll horizontally.
   * Use `never` only where the row is already known to fit — a strip that
   * scrolls hides its own options, which is the failure this replaces.
   */
  collapse?: 'auto' | 'never'
  /** Stretch items to fill the row. Off by default: the strip hugs its labels. */
  fullWidth?: boolean
  /**
   * Wires each item to its panel as `${idPrefix}-tab-${value}` /
   * `${idPrefix}-tabpanel-${value}`. Only meaningful for `role="tablist"`.
   */
  idPrefix?: string
  items: ReadonlyArray<TabBarItem<T>>
  onChange: (value: T) => void
  /**
   * `tablist` when the strip switches panels, `radiogroup` when it narrows a
   * list or chooses a compact form value. The look is identical; only what a
   * screen reader announces differs.
   */
  role?: 'tablist' | 'radiogroup'
  size?: 'sm' | 'md'
  value: T
}

type Pill = { animate: boolean; left: number; width: number }

/**
 * The one compact, single-select strip in the admin: channel/detail tabs, page
 * sections, filters, and compact form choices. The selected item is a single
 * pill that *slides* to whatever was tapped rather than a per-item background
 * that blinks on and off, so a selection change reads as one object moving.
 *
 * Below the width its labels need, the strip is not a strip: it becomes a
 * dropdown naming the current selection. That decision is a *measurement*, not
 * a breakpoint — the same six-item strip collapses in a narrow side panel on a
 * desktop and stays a strip on a phone when it only holds two short words, and
 * only measuring can tell those apart. See `docs/standards/design-system.md`
 * → "One selection strip, everywhere".
 */
export const TabBar = <T extends string>({
  ariaLabel,
  collapse = 'auto',
  fullWidth = false,
  idPrefix,
  items,
  onChange,
  role = 'tablist',
  size = 'md',
  value,
}: TabBarProps<T>) => {
  const shellRef = useRef<HTMLDivElement | null>(null)
  const trackRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const itemRefs = useRef(new Map<string, HTMLButtonElement>())
  const optionRefs = useRef(new Map<string, HTMLButtonElement>())
  const [pill, setPill] = useState<Pill | null>(null)
  const [collapsed, setCollapsed] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const menuId = useId()

  // The width the strip needs with every label laid out, carried across a
  // collapse: once the dropdown has replaced the strip there is nothing left
  // on screen to re-measure, so the last honest reading is what decides
  // whether a later widening has room to put the strip back.
  const naturalWidth = useRef<number | null>(null)

  const measure = useCallback(() => {
    const track = trackRef.current
    const active = itemRefs.current.get(value)
    if (!track || !active) return
    const left = active.offsetLeft
    const width = active.offsetWidth
    setPill((previous) =>
      previous && previous.left === left && previous.width === width
        ? previous
        : { animate: previous !== null, left, width },
    )
  }, [value])

  // While there is a strip both readings come off it, so they share a box
  // model: it is `width: fit-content` clamped by `max-width: 100%`, so when it
  // has room `scrollWidth === clientWidth`, and when it does not `clientWidth`
  // is exactly the room it was given. Once it is a dropdown the strip is gone
  // and the shell — the same box it was clamped to — reports that room.
  const measureFit = useCallback(() => {
    if (collapse === 'never') return
    const track = trackRef.current
    if (track) naturalWidth.current = track.scrollWidth
    const available = track ? track.clientWidth : (shellRef.current?.clientWidth ?? 0)
    setCollapsed((current) =>
      decideTabBarCollapse({ available, collapsed: current, natural: naturalWidth.current }),
    )
  }, [collapse])

  // Layout effect so the pill is already under the selected item on first paint
  // (that first placement is deliberately un-animated — see `Pill.animate`),
  // and so a strip that never had room is replaced before it is painted rather
  // than flashing as a clipped row and then snapping to a dropdown.
  // A compact screen may still need to scroll a `collapse="never"` strip; keep
  // the selected control wholly visible rather than leaving its label clipped.
  // Scroll the strip's own track only: scrollIntoView() walks every scrollable
  // ancestor, and this strip mounts inside screens that are mid-slide.
  useLayoutEffect(() => {
    measureFit()
    measure()
    const track = trackRef.current
    const active = itemRefs.current.get(value)
    if (!track || !active) return
    const left = active.offsetLeft
    const right = left + active.offsetWidth
    if (left < track.scrollLeft) track.scrollLeft = left
    else if (right > track.scrollLeft + track.clientWidth) {
      track.scrollLeft = right - track.clientWidth
    }
  }, [items, measure, measureFit, value])

  // Labels carry counts that change without the row resizing, so watch the
  // items themselves and not only the track. The shell is watched too: it is
  // the only thing left with a width once the strip has become a dropdown.
  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      measureFit()
      measure()
    })
    if (shellRef.current) observer.observe(shellRef.current)
    if (trackRef.current) observer.observe(trackRef.current)
    for (const node of itemRefs.current.values()) observer.observe(node)
    return () => observer.disconnect()
  }, [collapsed, items, measure, measureFit])

  const selectItem = (item: TabBarItem<T>) => {
    onChange(item.value)
    itemRefs.current.get(item.value)?.focus()
  }

  const move = (event: KeyboardEvent<HTMLDivElement>, step: -1 | 1) => {
    event.preventDefault()
    const index = items.findIndex((item) => item.value === value)
    if (index < 0) return
    for (let offset = 1; offset <= items.length; offset += 1) {
      const next = items[(index + step * offset + items.length) % items.length]
      if (next && !next.disabled) {
        selectItem(next)
        return
      }
    }
  }

  const moveToBoundary = (event: KeyboardEvent<HTMLDivElement>, step: -1 | 1) => {
    event.preventDefault()
    const start = step === 1 ? 0 : items.length - 1
    for (let index = start; index >= 0 && index < items.length; index += step) {
      const item = items[index]
      if (item && !item.disabled) {
        selectItem(item)
        return
      }
    }
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') move(event, 1)
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') move(event, -1)
    else if (event.key === 'Home') moveToBoundary(event, 1)
    else if (event.key === 'End') moveToBoundary(event, -1)
  }

  const isTabs = role === 'tablist'
  const selected = items.find((item) => item.value === value) ?? null

  const pick = (item: TabBarItem<T>) => {
    if (item.disabled) return
    if (item.value !== value) haptic('selection')
    onChange(item.value)
    setMenuOpen(false)
    triggerRef.current?.focus()
  }

  // Focus roves the options themselves rather than an `aria-activedescendant`
  // index: the panel is a list of real buttons, so the browser's own focus is
  // already the highlight and Enter/Space already activate.
  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()
    const usable = items.filter((item) => !item.disabled)
    if (usable.length === 0) return
    const active = document.activeElement
    const current = usable.findIndex((item) => optionRefs.current.get(item.value) === active)
    const step = event.key === 'ArrowDown' ? 1 : -1
    const start = current < 0 ? usable.findIndex((item) => item.value === value) : current
    const next = usable[(Math.max(start, 0) + step + usable.length) % usable.length]
    if (next) optionRefs.current.get(next.value)?.focus()
  }

  return (
    <div
      className={`tabbar-shell${fullWidth ? ' tabbar-shell-full' : ''}`}
      ref={shellRef}
    >
      {collapsed ? (
        <>
          <button
            aria-controls={menuOpen ? menuId : undefined}
            aria-expanded={menuOpen}
            aria-haspopup="listbox"
            aria-label={ariaLabel}
            className={`tabbar-trigger tabbar-trigger-${size}`}
            onClick={() => setMenuOpen((open) => !open)}
            ref={triggerRef}
            type="button"
          >
            <span className="tabbar-trigger-label">
              {selected?.icon}
              {selected?.label ?? ''}
              {selected?.count === undefined ? null : (
                <span className="tabbar-count">({selected.count})</span>
              )}
            </span>
            <FontAwesomeIcon className="tabbar-trigger-chevron" icon={faChevronDown} />
          </button>
          <Popover
            anchorRef={triggerRef}
            className="tabbar-menu"
            id={menuId}
            label={ariaLabel}
            onClose={() => setMenuOpen(false)}
            onKeyDown={onMenuKeyDown}
            open={menuOpen}
            placement="bottom-start"
            role="listbox"
          >
            {items.map((item) => (
              <button
                aria-selected={item.value === value}
                className="tabbar-option"
                data-testid={item.testId}
                disabled={item.disabled}
                key={item.value}
                onClick={() => pick(item)}
                ref={(node) => {
                  if (node) optionRefs.current.set(item.value, node)
                  else optionRefs.current.delete(item.value)
                }}
                role="option"
                title={item.title}
                type="button"
              >
                {item.icon}
                <span className="tabbar-option-label">{item.label}</span>
                {item.count === undefined ? null : (
                  <span className="tabbar-count">({item.count})</span>
                )}
              </button>
            ))}
          </Popover>
        </>
      ) : (
        <div
          aria-label={ariaLabel}
          className={`tabbar tabbar-${size}${fullWidth ? ' tabbar-full' : ''}`}
          onKeyDown={onKeyDown}
          ref={trackRef}
          role={role}
        >
          {pill ? (
            <span
              aria-hidden="true"
              className="tabbar-indicator"
              data-animate={pill.animate ? 'true' : 'false'}
              style={{ transform: `translateX(${pill.left}px)`, width: `${pill.width}px` }}
            />
          ) : null}
          {items.map((item) => {
            const isSelected = item.value === value
            return (
              <button
                aria-checked={isTabs ? undefined : isSelected}
                aria-controls={
                  isTabs && idPrefix ? `${idPrefix}-tabpanel-${item.value}` : undefined
                }
                aria-selected={isTabs ? isSelected : undefined}
                className="tabbar-item"
                data-testid={item.testId}
                disabled={item.disabled}
                id={isTabs && idPrefix ? `${idPrefix}-tab-${item.value}` : undefined}
                key={item.value}
                onClick={() => {
                  // A tab change is a selection tick in the native shell (§10);
                  // re-tapping the selected tab is not a change.
                  if (!isSelected) haptic('selection')
                  onChange(item.value)
                }}
                ref={(node) => {
                  if (node) itemRefs.current.set(item.value, node)
                  else itemRefs.current.delete(item.value)
                }}
                role={isTabs ? 'tab' : 'radio'}
                tabIndex={isSelected ? 0 : -1}
                title={item.title}
                type="button"
              >
                {item.icon}
                {item.label}
                {item.count === undefined ? null : (
                  <span className="tabbar-count">({item.count})</span>
                )}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
