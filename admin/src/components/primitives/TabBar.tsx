import { haptic } from '../../lib/haptics'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react'

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
 */
export const TabBar = <T extends string>({
  ariaLabel,
  fullWidth = false,
  idPrefix,
  items,
  onChange,
  role = 'tablist',
  size = 'md',
  value,
}: TabBarProps<T>) => {
  const trackRef = useRef<HTMLDivElement | null>(null)
  const itemRefs = useRef(new Map<string, HTMLButtonElement>())
  const [pill, setPill] = useState<Pill | null>(null)

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

  // Layout effect so the pill is already under the selected item on first paint
  // (that first placement is deliberately un-animated — see `Pill.animate`).
  // A compact screen may need to scroll this shared strip; keep the selected
  // control wholly visible rather than leaving its label clipped at an edge.
  // Scroll the strip's own track only: scrollIntoView() walks every scrollable
  // ancestor, and this strip mounts inside screens that are mid-slide.
  useLayoutEffect(() => {
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
  }, [items, measure, value])

  // Labels carry counts that change without the row resizing, so watch the
  // items themselves and not only the track.
  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => measure())
    if (trackRef.current) observer.observe(trackRef.current)
    for (const node of itemRefs.current.values()) observer.observe(node)
    return () => observer.disconnect()
  }, [items, measure])

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

  return (
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
        const selected = item.value === value
        return (
          <button
            aria-checked={isTabs ? undefined : selected}
            aria-controls={isTabs && idPrefix ? `${idPrefix}-tabpanel-${item.value}` : undefined}
            aria-selected={isTabs ? selected : undefined}
            className="tabbar-item"
            data-testid={item.testId}
            disabled={item.disabled}
            id={isTabs && idPrefix ? `${idPrefix}-tab-${item.value}` : undefined}
            key={item.value}
            onClick={() => {
              // A tab change is a selection tick in the native shell (§10);
              // re-tapping the selected tab is not a change.
              if (!selected) haptic('selection')
              onChange(item.value)
            }}
            ref={(node) => {
              if (node) itemRefs.current.set(item.value, node)
              else itemRefs.current.delete(item.value)
            }}
            role={isTabs ? 'tab' : 'radio'}
            tabIndex={selected ? 0 : -1}
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
  )
}
