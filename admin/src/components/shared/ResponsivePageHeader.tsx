import {
  faChevronDown,
  faEllipsis,
  type IconDefinition,
} from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import {
  partitionPageHeaderActions,
  type PageHeaderActionLayout,
} from './responsive-page-header-layout'
import { PageHeaderMenu } from './PageHeaderMenu'
import { SectionLabel } from '../primitives/SectionLabel'
import {
  HeaderAccountMenu,
  useHeaderAccountMenuVisible,
} from '../../layouts/admin-shell/AccountMenuContext'
import { PhoneBackButton } from '../../layouts/admin-shell/PhoneBackButton'

type PageHeaderMenuItemBase = {
  checked?: boolean
  disabled?: boolean
  icon?: IconDefinition
  id: string
  label: string
  title?: string
}

export type PageHeaderMenuButtonItem = PageHeaderMenuItemBase & {
  onSelect: () => void
}

export type PageHeaderMenuLinkItem = PageHeaderMenuItemBase & {
  href: string
  rel?: string
  target?: string
}

export type PageHeaderMenuItem = PageHeaderMenuButtonItem | PageHeaderMenuLinkItem

type PageHeaderActionBase = {
  compact?: boolean
  disabled?: boolean
  form?: string
  icon?: IconDefinition
  id: string
  label: string
  primary?: boolean
  priority: number
  pressed?: boolean
  selected?: boolean
  title?: string
}

export type PageHeaderButtonAction = PageHeaderActionBase & {
  kind?: 'button'
  onSelect: () => void
  submit?: boolean
}

export type PageHeaderLinkAction = PageHeaderActionBase & {
  href: string
  kind: 'link'
  rel?: string
  target?: string
}

export type PageHeaderMenuAction = PageHeaderActionBase & {
  items: PageHeaderMenuItem[]
  kind: 'menu'
}

export type PageHeaderAction = PageHeaderButtonAction | PageHeaderLinkAction | PageHeaderMenuAction

export type ResponsivePageHeaderProps = {
  actions?: PageHeaderAction[]
  eyebrow?: string
  leading?: ReactNode
  onBack?: () => void
  title: string
  titleInput?: {
    ariaLabel: string
    onChange: (value: string) => void
    placeholder: string
    value: string
  }
  titleTone?: 'page' | 'section'
}

const ACTION_GAP = 8
const ACCOUNT_MENU_WIDTH = 40
// Minimum title lane when the header carries no measured extras at all.
const MIN_LEADING_WIDTH = 152
const MORE_ACTION_ID = '__page-header-more'
const moreAction: PageHeaderButtonAction = {
  compact: true,
  id: MORE_ACTION_ID,
  label: 'More',
  onSelect: () => undefined,
  priority: 0,
}

const sameIds = (left: string[], right: string[]): boolean =>
  left.length === right.length && left.every((id, index) => id === right[index])

const actionClassName = (action: PageHeaderAction, open: boolean): string => {
  const colour = action.primary
    ? 'border border-transparent bg-[color:var(--accent)] text-[color:var(--on-accent)] hover:opacity-90'
    : action.selected
      ? 'border border-[color:var(--accent)] bg-[color:var(--accent-soft)] text-[color:var(--accent)]'
      : 'border border-[color:var(--sep)] bg-[color:var(--overlay-weak)] text-[color:var(--tx2)] hover:bg-[color:var(--overlay)] hover:text-[color:var(--tx)]'
  return [
    'inline-flex h-8 items-center justify-center rounded-md text-xs font-semibold transition-colors',
    action.compact ? 'w-8 px-0' : 'gap-1.5 px-2.5',
    colour,
    open ? 'ring-2 ring-[color:var(--accent-soft)]' : '',
    action.disabled ? 'cursor-not-allowed opacity-50' : '',
  ].join(' ')
}

// A shared header for dense admin surfaces. It measures the actual controls at
// runtime, so the same action declarations remain usable in a wide workspace,
// a narrow project tab, and a tablet WebView without brittle viewport rules.
export const ResponsivePageHeader = ({
  actions = [],
  eyebrow,
  leading,
  onBack,
  title,
  titleInput,
  titleTone = 'page',
}: ResponsivePageHeaderProps) => {
  const showHeaderAccountMenu = useHeaderAccountMenuVisible()
  const headerRef = useRef<HTMLElement>(null)
  const measurementRef = useRef<HTMLDivElement>(null)
  const leadingMeasureRef = useRef<HTMLDivElement>(null)
  const actionMeasureRefs = useRef<Record<string, HTMLDivElement | null>>({})
  const moreMeasureRef = useRef<HTMLDivElement>(null)
  const triggerRefs = useRef<Record<string, HTMLElement | null>>({})
  const menuRefs = useRef<Record<string, HTMLDivElement | null>>({})
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

  useEffect(() => {
    if (!openMenu) return undefined
    const frame = requestAnimationFrame(() => {
      menuRefs.current[openMenu]?.querySelector<HTMLElement>('[role^="menuitem"]')?.focus()
    })
    const closeForOutsidePointer = (event: MouseEvent) => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (menuRefs.current[openMenu]?.contains(target) || triggerRefs.current[openMenu]?.contains(target)) return
      setOpenMenu(null)
      requestAnimationFrame(() => triggerRefs.current[openMenu]?.focus())
    }
    document.addEventListener('mousedown', closeForOutsidePointer)
    return () => {
      cancelAnimationFrame(frame)
      document.removeEventListener('mousedown', closeForOutsidePointer)
    }
  }, [openMenu])

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
  const selectMenuItem = (item: PageHeaderMenuButtonItem | PageHeaderButtonAction) => {
    closeMenu(false)
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
  const renderAction = (action: PageHeaderAction, measuring = false): ReactNode => {
    if (action.kind === 'link') {
      return (
        <a
          aria-label={action.compact ? action.label : undefined}
          className={actionClassName(action, false)}
          href={action.href}
          rel={action.rel}
          target={action.target}
          title={action.title ?? action.label}
        >
          {action.icon ? <FontAwesomeIcon className="h-3 w-3" fixedWidth icon={action.icon} /> : null}
          {action.compact ? null : <span>{action.label}</span>}
        </a>
      )
    }
    const isMenu = action.kind === 'menu'
    const buttonAction = isMenu ? null : action
    const isOpen = !measuring && openMenu === action.id
    const menuId = `${menuIdPrefix}-${action.id}`
    return (
      <button
        aria-controls={isMenu ? menuId : undefined}
        aria-expanded={isMenu ? isOpen : undefined}
        aria-haspopup={isMenu ? 'menu' : undefined}
        aria-label={action.compact ? action.label : undefined}
        aria-pressed={isMenu ? undefined : action.pressed}
        className={actionClassName(action, isOpen)}
        disabled={action.disabled}
        form={action.form}
        onClick={
          measuring
            ? undefined
            : isMenu
              ? () => toggleMenu(action.id)
              : action.onSelect
        }
        ref={(element) => {
          if (!measuring) triggerRefs.current[action.id] = element
        }}
        title={action.title ?? action.label}
        type={buttonAction?.submit ? 'submit' : 'button'}
      >
        {action.icon ? <FontAwesomeIcon className="h-3 w-3" fixedWidth icon={action.icon} /> : null}
        {action.compact ? null : <span>{action.label}</span>}
        {isMenu ? <FontAwesomeIcon className="h-2.5 w-2.5" icon={faChevronDown} /> : null}
      </button>
    )
  }

  return (
    <header
      className="relative flex h-[50px] flex-shrink-0 items-center gap-3 border-b border-[color:var(--sep)] px-4"
      ref={headerRef}
    >
      <div className="flex min-w-0 flex-1 items-center gap-3">
        {leading || onBack ? (
          <div className="flex flex-shrink-0 items-center gap-3">
            {leading}
            {onBack ? (
              <PhoneBackButton label={`Back from ${title}`} onBack={onBack} />
            ) : null}
          </div>
        ) : null}
        <div className="min-w-0 flex-1">
          {eyebrow ? (
            <div className="truncate text-[10px] font-semibold uppercase tracking-[0.2em] text-[color:var(--tx3)]">
              {eyebrow}
            </div>
          ) : null}
          {titleInput ? (
            <input
              aria-label={titleInput.ariaLabel}
              className="w-full border-none bg-transparent text-[15px] font-semibold text-[color:var(--tx)] outline-none placeholder:text-[color:var(--tx3)]"
              onChange={(event) => titleInput.onChange(event.target.value)}
              placeholder={titleInput.placeholder}
              value={titleInput.value}
            />
          ) : titleTone === 'section' ? (
            <SectionLabel as="h2" className="truncate">
              {title}
            </SectionLabel>
          ) : (
            <h1 className="truncate text-[17px] font-bold text-[color:var(--tx)]">{title}</h1>
          )}
        </div>
      </div>

      {actions.length > 0 || showHeaderAccountMenu ? (
        <div className="flex flex-shrink-0 items-center gap-2">
          {visibleActions.map((action) => (
            <div className="relative" key={action.id}>
              {renderAction(action)}
              {openMenu === action.id && action.kind === 'menu' ? (
                <div
                  className="absolute right-0 top-full z-30 mt-1 min-w-52 rounded-lg border border-[color:var(--sep)] bg-[color:var(--main)] p-1 shadow-lg"
                  id={`${menuIdPrefix}-${action.id}`}
                  onKeyDown={handleMenuKeys}
                  ref={(element) => { menuRefs.current[action.id] = element }}
                  role="menu"
                >
                  <PageHeaderMenu action={action} onSelect={selectMenuItem} />
                </div>
              ) : null}
            </div>
          ))}
          {overflowActions.length > 0 ? (
            <div className="relative">
              <button
                aria-controls={`${menuIdPrefix}-${MORE_ACTION_ID}`}
                aria-expanded={openMenu === MORE_ACTION_ID}
                aria-haspopup="menu"
                aria-label="More page actions"
                className={actionClassName(moreAction, openMenu === MORE_ACTION_ID)}
                onClick={() => toggleMenu(MORE_ACTION_ID)}
                ref={(element) => { triggerRefs.current[MORE_ACTION_ID] = element }}
                title="More page actions"
                type="button"
              >
                <FontAwesomeIcon className="h-3 w-3" icon={faEllipsis} />
              </button>
              {openMenu === MORE_ACTION_ID ? (
                <div
                  className="absolute right-0 top-full z-30 mt-1 min-w-52 rounded-lg border border-[color:var(--sep)] bg-[color:var(--main)] p-1 shadow-lg"
                  id={`${menuIdPrefix}-${MORE_ACTION_ID}`}
                  onKeyDown={handleMenuKeys}
                  ref={(element) => { menuRefs.current[MORE_ACTION_ID] = element }}
                  role="menu"
                >
                  {overflowActions.map((action, index) => (
                    <div key={action.id}>
                      <PageHeaderMenu action={action} onSelect={selectMenuItem} />
                      {index < overflowActions.length - 1 ? <div className="my-1 border-t border-[color:var(--sep)]" /> : null}
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
          <HeaderAccountMenu />
        </div>
      ) : null}

      <div
        aria-hidden="true"
        className="pointer-events-none invisible absolute left-0 top-0 flex items-center gap-2 whitespace-nowrap"
        ref={measurementRef}
      >
        {/* Mirrors the visible leading lane (leading + Back with the same
            gap-3 rhythm) so the reserve below is the measured intrinsic
            width of what actually rendered — including the case where a
            conditional doorway rendered nothing at all. */}
        <div className="flex items-center gap-3" ref={leadingMeasureRef}>
          {leading}
          {onBack ? (
            <PhoneBackButton label={`Back from ${title}`} onBack={onBack} />
          ) : null}
        </div>
        {actions.map((action) => (
          <div key={action.id} ref={(element) => { actionMeasureRefs.current[action.id] = element }}>
            {renderAction(action, true)}
          </div>
        ))}
        <div ref={moreMeasureRef}>
          <button className={actionClassName(moreAction, false)} type="button">
            <FontAwesomeIcon className="h-3 w-3" icon={faEllipsis} />
          </button>
        </div>
      </div>
    </header>
  )
}
