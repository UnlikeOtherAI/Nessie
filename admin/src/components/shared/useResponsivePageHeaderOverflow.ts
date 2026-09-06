import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from 'react'
import {
  partitionPageHeaderActions,
  type PageHeaderActionLayout,
} from './responsive-page-header-layout'
import type {
  PageHeaderAction,
  PageHeaderButtonAction,
  PageHeaderMenuButtonItem,
  PageHeaderToggleAction,
} from './ResponsivePageHeader'

const ACTION_GAP = 8
const ACCOUNT_MENU_WIDTH = 40
// Minimum title lane when the header carries no measured extras at all.
const MIN_LEADING_WIDTH = 152
export const MORE_ACTION_ID = '__page-header-more'

const sameIds = (left: string[], right: string[]): boolean =>
  left.length === right.length && left.every((id, index) => id === right[index])

export type UseResponsivePageHeaderOverflowOptions = {
  actions: PageHeaderAction[]
  onBack?: () => void
  showHeaderAccountMenu: boolean
}

// The overflow-measurement engine behind `ResponsivePageHeader`: it measures
// the actual rendered controls at runtime and decides which stay in the row
// versus collapse into "More", plus the menu-open/keyboard state for both the
// per-action menus and the "More" overflow menu. It has no JSX of its own —
// the component keeps the presentational half (`renderAction`,
// `actionClassName`, `toggleClassName`) and the header markup.
export const useResponsivePageHeaderOverflow = ({
  actions,
  onBack,
  showHeaderAccountMenu,
}: UseResponsivePageHeaderOverflowOptions) => {
  const headerRef = useRef<HTMLElement>(null)
  const measurementRef = useRef<HTMLDivElement>(null)
  const leadingMeasureRef = useRef<HTMLDivElement>(null)
  const actionMeasureRefs = useRef<Record<string, HTMLDivElement | null>>({})
  const moreMeasureRef = useRef<HTMLDivElement>(null)
  const triggerRefs = useRef<Record<string, HTMLElement | null>>({})
  // One stable RefObject per action id, reading through to the live trigger
  // node: the Popover keeps its anchor across renders, and a trigger that has
  // not mounted yet simply reads null.
  const anchorRefs = useRef<Record<string, RefObject<HTMLElement | null>>>({})
  const anchorRefFor = (id: string): RefObject<HTMLElement | null> => {
    anchorRefs.current[id] ??= { get current() { return triggerRefs.current[id] ?? null } }
    return anchorRefs.current[id] as RefObject<HTMLElement | null>
  }
  const [visibleIds, setVisibleIds] = useState(() => actions.map((action) => action.id))
  const [overflowIds, setOverflowIds] = useState<string[]>([])
  const [openMenu, setOpenMenu] = useState<string | null>(null)
  const menuIdPrefix = useId().replaceAll(':', '')

  const actionById = useMemo(
    () => new Map(actions.map((action) => [action.id, action])),
    [actions],
  )
  const visibleActions = visibleIds.flatMap((id) => {
    const action = actionById.get(id)
    return action ? [action] : []
  })
  const overflowActions = overflowIds.flatMap((id) => {
    const action = actionById.get(id)
    return action ? [action] : []
  })

  useLayoutEffect(() => {
    const header = headerRef.current
    if (!header) return undefined

    let frame: number | undefined
    const recalculate = () => {
      const moreWidth = moreMeasureRef.current?.getBoundingClientRect().width ?? 0
      const layouts: PageHeaderActionLayout[] = actions.map((action) => ({
        id: action.id,
        primary: action.primary,
        priority: action.priority,
        width: actionMeasureRefs.current[action.id]?.getBoundingClientRect().width ?? 0,
      }))
      if (moreWidth === 0 || layouts.some((action) => action.width === 0)) return

      // The leading lane reserve is measured, never element-truthiness:
      // leading can be a conditional doorway (the phone navigation button)
      // that renders null on desktop, where `Boolean(leading)` would still
      // reserve ~48px and collapse the actions early (D7). The intrinsic row
      // holds whatever leading/onBack actually rendered this pass; only the
      // title lane's minimum width stays a constant.
      const leadingReserve = Math.max(
        leadingMeasureRef.current?.getBoundingClientRect().width ?? 0,
        MIN_LEADING_WIDTH,
      )
      const next = partitionPageHeaderActions(
        layouts,
        Math.max(
          0,
          header.clientWidth - leadingReserve - (showHeaderAccountMenu ? ACCOUNT_MENU_WIDTH : 0),
        ),
        moreWidth,
        ACTION_GAP,
      )
      setVisibleIds((current) => (sameIds(current, next.visibleIds) ? current : next.visibleIds))
      setOverflowIds((current) => (sameIds(current, next.overflowIds) ? current : next.overflowIds))
    }
    const schedule = () => {
      if (frame !== undefined) cancelAnimationFrame(frame)
      frame = requestAnimationFrame(recalculate)
    }

    schedule()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule)
    observer?.observe(header)
    // The hidden intrinsic row holds the measured content: observing it keeps
    // the partition honest when the intrinsics change without a header resize
    // — font-scale/zoom, a doorway appearing on phone, late-loaded controls
    // (D8).
    const measurement = measurementRef.current
    if (measurement) observer?.observe(measurement)
    return () => {
      if (frame !== undefined) cancelAnimationFrame(frame)
      observer?.disconnect()
    }
  }, [actions, onBack, showHeaderAccountMenu])

  // Outside press and Escape belong to the Popover primitive; the header keeps
  // only the menu's own keyboard model — first item focused on open, arrows
  // between items — because a menu that opens under the pointer still has to
  // be reachable from the keyboard.
  useEffect(() => {
    if (!openMenu) return undefined
    const menuId = `${menuIdPrefix}-${openMenu}`
    const frame = requestAnimationFrame(() => {
      document.getElementById(menuId)?.querySelector<HTMLElement>('[role^="menuitem"]')?.focus()
    })
    return () => cancelAnimationFrame(frame)
  }, [menuIdPrefix, openMenu])

  useEffect(() => {
    const focusedOverflowAction = overflowIds.find((id) => document.activeElement === triggerRefs.current[id])
    if (!focusedOverflowAction) return
    requestAnimationFrame(() => triggerRefs.current[MORE_ACTION_ID]?.focus())
  }, [overflowIds])

  const closeMenu = (restoreFocus = true) => {
    const menu = openMenu
    setOpenMenu(null)
    if (menu && restoreFocus) requestAnimationFrame(() => triggerRefs.current[menu]?.focus())
  }
  const selectMenuItem = (
    item: PageHeaderMenuButtonItem | PageHeaderButtonAction | PageHeaderToggleAction,
  ) => {
    closeMenu(false)
    if ('kind' in item && item.kind === 'toggle') {
      item.onChange(!item.checked)
      return
    }
    item.onSelect()
  }
  const handleMenuKeys = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      closeMenu()
      return
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    const items = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>('[role^="menuitem"]'),
    )
    if (items.length === 0) return
    event.preventDefault()
    const current = items.indexOf(document.activeElement as HTMLElement)
    const next = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? items.length - 1
        : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
    items[next]?.focus()
  }
  const toggleMenu = (id: string) => setOpenMenu((current) => (current === id ? null : id))

  return {
    actionMeasureRefs,
    anchorRefFor,
    closeMenu,
    handleMenuKeys,
    headerRef,
    leadingMeasureRef,
    measurementRef,
    menuIdPrefix,
    moreMeasureRef,
    openMenu,
    overflowActions,
    selectMenuItem,
    toggleMenu,
    triggerRefs,
    visibleActions,
  }
}
