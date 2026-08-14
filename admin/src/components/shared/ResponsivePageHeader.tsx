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
import {
  HeaderAccountMenu,
  useHeaderAccountMenuVisible,
} from '../../layouts/admin-shell/AccountMenuContext'
import { PhoneBackButton } from '../../layouts/admin-shell/PhoneBackButton'

export type PageHeaderMenuItem = {
  checked?: boolean
  disabled?: boolean
  icon?: IconDefinition
  id: string
  label: string
  onSelect: () => void
  title?: string
}

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

export type PageHeaderMenuAction = PageHeaderActionBase & {
  items: PageHeaderMenuItem[]
  kind: 'menu'
}

export type PageHeaderAction = PageHeaderButtonAction | PageHeaderMenuAction

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

type HeaderMenuProps = {
  action: PageHeaderAction
  onSelect: (item: PageHeaderMenuItem | PageHeaderButtonAction) => void
}

const ACTION_GAP = 8
const ACCOUNT_MENU_WIDTH = 40
const MIN_LEADING_WIDTH = 152
const MIN_LEADING_WIDTH_WITH_LEADING = 200
const MIN_LEADING_WIDTH_WITH_BACK = 210
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

const HeaderMenu = ({ action, onSelect }: HeaderMenuProps) => {
  const items = action.kind === 'menu' ? action.items : [action]

  return (
    <>
      {action.kind === 'menu' ? (
        <div className="px-2.5 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wide text-[color:var(--tx3)]">
          {action.label}
        </div>
      ) : null}
      {items.map((item) => {
        const checked = 'checked' in item ? item.checked : undefined
        const icon = item.icon
        const role = checked === undefined ? 'menuitem' : 'menuitemradio'
        return (
          <button
            aria-checked={checked}
            className={[
              'flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-xs',
              'text-[color:var(--tx2)] hover:bg-[color:var(--overlay)] hover:text-[color:var(--tx)]',
              checked ? 'bg-[color:var(--accent-soft)] text-[color:var(--accent)]' : '',
              item.disabled ? 'cursor-not-allowed opacity-50' : '',
            ].join(' ')}
            disabled={item.disabled}
            key={item.id}
            onClick={() => onSelect(item)}
            role={role}
            title={item.title}
            type="button"
          >
            {icon ? <FontAwesomeIcon className="h-3 w-3" fixedWidth icon={icon} /> : null}
            <span className="min-w-0 flex-1 truncate">{item.label}</span>
            {checked ? <span aria-hidden="true">✓</span> : null}
          </button>
        )
      })}
    </>
  )
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
  const actionMeasureRefs = useRef<Record<string, HTMLDivElement | null>>({})
  const moreMeasureRef = useRef<HTMLDivElement>(null)
  const triggerRefs = useRef<Record<string, HTMLButtonElement | null>>({})
  const menuRefs = useRef<Record<string, HTMLDivElement | null>>({})
  const [visibleIds, setVisibleIds] = useState(() => actions.map((action) => action.id))
  const [overflowIds, setOverflowIds] = useState<string[]>([])
  const [openMenu, setOpenMenu] = useState<string | null>(null)
  const menuIdPrefix = useId().replaceAll(':', '')
  const hasLeading = Boolean(leading)

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

      const next = partitionPageHeaderActions(
        layouts,
        Math.max(
          0,
          header.clientWidth - (
            onBack
              ? MIN_LEADING_WIDTH_WITH_BACK
              : hasLeading
                ? MIN_LEADING_WIDTH_WITH_LEADING
                : MIN_LEADING_WIDTH
          ) - (showHeaderAccountMenu ? ACCOUNT_MENU_WIDTH : 0),
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
    return () => {
      if (frame !== undefined) cancelAnimationFrame(frame)
      observer?.disconnect()
    }
  }, [actions, hasLeading, onBack, showHeaderAccountMenu])

  useEffect(() => {
    if (!openMenu) return undefined
    const frame = requestAnimationFrame(() => {
      menuRefs.current[openMenu]?.querySelector<HTMLButtonElement>('[role^="menuitem"]')?.focus()
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
  const selectMenuItem = (item: PageHeaderMenuItem | PageHeaderButtonAction) => {
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
      event.currentTarget.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]'),
    )
    if (items.length === 0) return
    event.preventDefault()
    const current = items.indexOf(document.activeElement as HTMLButtonElement)
    const next = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? items.length - 1
        : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
    items[next]?.focus()
  }
  const toggleMenu = (id: string) => setOpenMenu((current) => (current === id ? null : id))
  const renderAction = (action: PageHeaderAction, measuring = false): ReactNode => {
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
        {leading}
        {onBack ? (
          <PhoneBackButton label={`Back from ${title}`} onBack={onBack} />
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
            <h2 className="truncate text-xs font-semibold uppercase tracking-[0.2em] text-[color:var(--tx3)]">
              {title}
            </h2>
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
                  <HeaderMenu action={action} onSelect={selectMenuItem} />
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
                      <HeaderMenu action={action} onSelect={selectMenuItem} />
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
