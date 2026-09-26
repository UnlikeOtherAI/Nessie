import type { IconDefinition } from '@fortawesome/free-solid-svg-icons'
import type { ReactNode } from 'react'
import type { ScreenBarIconName } from '../../navigation/screen-bar'

type PageHeaderMenuItemBase = {
  checked?: boolean
  /**
   * The row is an independent on and off — "Show archived" — rather than one
   * choice out of a set, which is what a `checked` row otherwise means. It
   * decides how the row is announced: a checkbox stands alone, where a radio
   * says "3 of 3" and implies the rows beside it are the alternatives.
   */
  checkbox?: boolean
  // The little line underneath the label — a sync row's freshness sentence.
  // The row stays one press; the detail is read, not pressed.
  detail?: string
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

// A hairline rule between groups of rows. `aria-hidden`: the grouping it
// marks is visible, and a screen reader already hears the groups' edges.
export type PageHeaderMenuSeparatorItem = {
  id: string
  kind: 'separator'
}

// A small muted line of text — the board's "Showing the 500 most recently
// updated cards." footnote. It answers a question and offers no press, so it
// is not a `menuitem` and takes no focus.
export type PageHeaderMenuNoteItem = {
  id: string
  kind: 'note'
  label: string
}

export type PageHeaderMenuItem =
  | PageHeaderMenuButtonItem
  | PageHeaderMenuLinkItem
  | PageHeaderMenuNoteItem
  | PageHeaderMenuSeparatorItem

type PageHeaderActionBase = {
  /**
   * The glyph the *native* bar should draw for this action, from its closed
   * set. Separate from `icon`: that one is FontAwesome for the web header,
   * and the native bar draws Material glyphs from a vocabulary it owns.
   */
  barIcon?: ScreenBarIconName
  compact?: boolean
  disabled?: boolean
  form?: string
  icon?: IconDefinition
  id: string
  label: string
  // Never collapses into More. For a control that carries the screen's own
  // state rather than firing an action — a menu row could not stand in for it.
  pinned?: boolean
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
// stays readable and the bar says what it is filtered by.
export type PageHeaderToggleAction = PageHeaderActionBase & {
  checked: boolean
  kind: 'toggle'
  onChange: (checked: boolean) => void
}

// A control the screen draws itself, sitting in the action row so it keeps the
// row's order and measured share of the width. It is pinned because More
// renders menu items, and this action has none.
export type PageHeaderCustomAction = PageHeaderActionBase & {
  kind: 'custom'
  pinned: true
  render: (measuring: boolean) => ReactNode
}

export type PageHeaderAction =
  | PageHeaderButtonAction
  | PageHeaderCustomAction
  | PageHeaderLinkAction
  | PageHeaderMenuAction
  | PageHeaderToggleAction
