import {
  faChevronDown,
  faEllipsis,
  type IconDefinition,
} from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import type { ReactNode } from 'react'
import { Popover } from '../overlays/Popover'
import { PageHeaderMenu } from './PageHeaderMenu'
import { SectionLabel } from '../primitives/SectionLabel'
import { Switch } from '../primitives/Switch'
import {
  HeaderAccountMenu,
  useHeaderAccountMenuVisible,
} from '../../layouts/admin-shell/ShellStateContext'
import { PhoneBackButton } from '../../navigation/PhoneBackButton'
import {
  MORE_ACTION_ID,
  useResponsivePageHeaderOverflow,
} from './useResponsivePageHeaderOverflow'

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
  // The action's mark reads red under the pointer. For a control whose colour
  // is part of what it means — the routine-recording button — rather than a
  // warning about the click; the box itself keeps the shared treatment.
  tone?: 'danger'
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

// A header filter that is on or off rather than an action you fire: the label
// stays readable and the switch carries the state, so the bar says what it is
// filtered by without the reader having to decode a highlighted button.
export type PageHeaderToggleAction = PageHeaderActionBase & {
  checked: boolean
  kind: 'toggle'
  onChange: (checked: boolean) => void
}

export type PageHeaderAction =
  | PageHeaderButtonAction
  | PageHeaderLinkAction
  | PageHeaderMenuAction
  | PageHeaderToggleAction

export type ResponsivePageHeaderProps = {
  actions?: PageHeaderAction[]
  // Rendered inside the header block, under the title row: `ScreenHeader`'s
  // subtitle and tabs slots. One bordered block, never a second header.
  below?: ReactNode
  eyebrow?: string
  // The title's heading level. `h1` is the screen's own title — the one the
  // settle focuses (docs/navigation/overview.md §12) — and `h2` is for the panes and
  // panels that sit *inside* a screen, which keep the same look.
  heading?: 'h1' | 'h2'
  leading?: ReactNode
  onBack?: () => void
  title: string
  titleId?: string
  titleInput?: {
    ariaLabel: string
    onChange: (value: string) => void
    placeholder: string
    value: string
  }
  titleTone?: 'page' | 'section'
}

const moreAction: PageHeaderButtonAction = {
  compact: true,
  id: MORE_ACTION_ID,
  label: 'More',
  onSelect: () => undefined,
  priority: 0,
}

const menuPanelClassName = [
  'min-w-52 rounded-lg border border-[color:var(--sep)]',
  'bg-[color:var(--main)] p-1 shadow-lg',
].join(' ')

// The action's role, not its colours. Which fill a role wears — and what a
// theme does to it — belongs to `.admin-page-action*` in `styles.css`, where
// the hover and focus treatment already lives; utilities that stayed here own
// the box (height, width, gap, padding) and nothing about how it reads. Spelt
// as colours at this call site, a hover rule in the stylesheet had nothing to
// attach to, which is how the header's hover became a no-op the moment the
// resting state gained a fill of its own.
const actionClassName = (action: PageHeaderAction, open: boolean): string => {
  const role = action.primary
    ? 'admin-page-action-primary'
    : action.selected
      ? 'admin-page-action-selected'
      : 'admin-page-action-secondary'
  return [
    'admin-page-action inline-flex h-8 items-center justify-center text-xs transition-colors',
    action.compact ? 'w-8 px-0' : 'gap-1.5 px-2.5',
    role,
    action.tone === 'danger' ? 'page-header-action-danger' : '',
    open ? 'admin-page-action-open' : '',
    action.disabled ? 'cursor-not-allowed opacity-50' : '',
  ].join(' ')
}

// A toggle is read, not clicked: it keeps the action row's height and type
// scale but drops the button box, so it reads as a labelled switch rather than
// one more control competing with the page's real actions.
const toggleClassName = (action: PageHeaderToggleAction): string => [
  'admin-page-toggle inline-flex h-8 items-center gap-2 px-1 text-xs font-medium',
  'whitespace-nowrap text-[color:var(--tx2)]',
  action.disabled ? 'cursor-not-allowed opacity-50' : '',
].join(' ')

// A shared header for dense admin surfaces. It measures the actual controls at
// runtime, so the same action declarations remain usable in a wide team,
// a narrow project tab, and a tablet WebView without brittle viewport rules.
export const ResponsivePageHeader = ({
  actions = [],
  below,
  eyebrow,
  heading = 'h1',
  leading,
  onBack,
  title,
  titleId,
  titleInput,
  titleTone = 'page',
}: ResponsivePageHeaderProps) => {
  const showHeaderAccountMenu = useHeaderAccountMenuVisible()
  const {
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
  } = useResponsivePageHeaderOverflow({ actions, onBack, showHeaderAccountMenu })
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
    if (action.kind === 'toggle') {
      return (
        <span className={toggleClassName(action)} title={action.title ?? action.label}>
          <span>{action.label}</span>
          {/* The switch's name stays the label whichever way it is thrown —
              `aria-checked` is what says on or off, so a name that flipped
              with the state would announce the filter twice and never the
              same way. */}
          <Switch
            checked={action.checked}
            disabled={action.disabled}
            label={action.label}
            onChange={measuring ? () => undefined : action.onChange}
          />
        </span>
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
        {isMenu && !action.compact ? (
          <FontAwesomeIcon className="h-2.5 w-2.5" icon={faChevronDown} />
        ) : null}
      </button>
    )
  }

  const Heading = heading

  return (
    // One block: the fixed-height title row, then whatever the screen renders
    // beneath it (subtitle, tab row). The border closes the whole block, so a
    // subtitle is inside the header rather than a second bar under it.
    <header
      className="relative flex flex-shrink-0 flex-col border-b border-[color:var(--sep)]"
      ref={headerRef}
    >
      <div className="flex h-[50px] flex-shrink-0 items-center gap-3 px-[var(--page-gutter)]">
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
              <Heading className="truncate text-[17px] font-bold text-[color:var(--tx)]" id={titleId}>
                {title}
              </Heading>
            )}
          </div>
        </div>

        {actions.length > 0 || showHeaderAccountMenu ? (
          <div className="flex flex-shrink-0 items-center gap-2">
            {visibleActions.map((action) => (
              <div className="relative" key={action.id}>
                {renderAction(action)}
                {action.kind === 'menu' ? (
                  <Popover
                    anchorRef={anchorRefFor(action.id)}
                    className={menuPanelClassName}
                    id={`${menuIdPrefix}-${action.id}`}
                    label={action.label}
                    onClose={() => closeMenu()}
                    onKeyDown={handleMenuKeys}
                    open={openMenu === action.id}
                    placement="bottom-end"
                    role="menu"
                  >
                    <PageHeaderMenu action={action} onSelect={selectMenuItem} />
                  </Popover>
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
                <Popover
                  anchorRef={anchorRefFor(MORE_ACTION_ID)}
                  className={menuPanelClassName}
                  id={`${menuIdPrefix}-${MORE_ACTION_ID}`}
                  label="More page actions"
                  onClose={() => closeMenu()}
                  onKeyDown={handleMenuKeys}
                  open={openMenu === MORE_ACTION_ID}
                  placement="bottom-end"
                  role="menu"
                >
                  {overflowActions.map((action, index) => (
                    <div key={action.id}>
                      <PageHeaderMenu action={action} onSelect={selectMenuItem} />
                      {index < overflowActions.length - 1 ? <div className="my-1 border-t border-[color:var(--sep)]" /> : null}
                    </div>
                  ))}
                </Popover>
              </div>
            ) : null}
            <HeaderAccountMenu />
          </div>
        ) : null}
      </div>

      {below ? <div className="min-w-0 px-[var(--page-gutter)] pb-2">{below}</div> : null}

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
