/**
 * The token field's behaviour as data: which rows the dropdown lists, and what
 * a key does. Pure — no React, no DOM — so every row of the key table
 * (docs/plans/2026-09-21-ticket-comments-attachments-labels/ui.md §5.7) is a
 * unit test instead of a browser run. `TokenInput` only applies the action.
 */

export type TokenInputToken = {
  id: string
  label: string
  /** False for a token the viewer may not take off (a source-owned label). */
  removable?: boolean
}

export type TokenInputOption = {
  id: string
  label: string
  disabled?: boolean
  title?: string
}

export type TokenInputRow =
  | { kind: 'option'; option: TokenInputOption; selected: boolean }
  | { kind: 'create'; text: string }

/** Case-insensitive, whitespace-trimmed — the label name rule. */
export const normalizeTokenText = (text: string): string => text.trim().toLowerCase()

export const exactOptionMatch = (
  options: readonly TokenInputOption[],
  query: string,
): TokenInputOption | null => {
  const wanted = normalizeTokenText(query)
  if (!wanted) return null
  return options.find((option) => normalizeTokenText(option.label) === wanted) ?? null
}

/**
 * Every option, the chosen ones first (in the options' own order), then the
 * rest; filtered by case-insensitive substring. A *Create* row is added when
 * creation is allowed and the trimmed text matches no option exactly — first
 * when nothing else matched, last otherwise.
 */
export const buildTokenRows = ({
  canCreate,
  options,
  query,
  selectedIds,
}: {
  canCreate: boolean
  options: readonly TokenInputOption[]
  query: string
  selectedIds: readonly string[]
}): TokenInputRow[] => {
  const selected = new Set(selectedIds)
  const needle = normalizeTokenText(query)
  const matches = (option: TokenInputOption) =>
    needle === '' || option.label.toLowerCase().includes(needle)
  const chosen: TokenInputRow[] = []
  const rest: TokenInputRow[] = []
  for (const option of options) {
    if (!matches(option)) continue
    const row: TokenInputRow = { kind: 'option', option, selected: selected.has(option.id) }
    if (row.selected) chosen.push(row)
    else rest.push(row)
  }
  const rows = [...chosen, ...rest]
  const text = query.trim()
  if (!canCreate || text === '' || exactOptionMatch(options, text)) return rows
  const create: TokenInputRow = { kind: 'create', text }
  return rows.length === 0 ? [create] : [...rows, create]
}

export type TokenKeyState = {
  /** Index into `rows`, or null when no row is active. */
  activeIndex: number | null
  canCreate: boolean
  /** The token Backspace has marked for removal, if any. */
  highlightedTokenId: string | null
  open: boolean
  options: readonly TokenInputOption[]
  query: string
  rows: readonly TokenInputRow[]
  tokens: readonly TokenInputToken[]
}

export type TokenKeyAction =
  /** Nothing to do; the browser's default stands (typing, caret moves). */
  | { type: 'none' }
  | { type: 'open'; activeIndex: number | null }
  | { type: 'move'; activeIndex: number }
  /** Add the option when it is not chosen, remove it when it is. */
  | { type: 'toggle'; id: string }
  /** Add the option; a no-op when it is already chosen. */
  | { type: 'add'; id: string }
  | { type: 'create'; text: string }
  | { type: 'highlight-token'; id: string }
  | { type: 'remove-token'; id: string }
  | { type: 'close' }

export type TokenKeyDecision = {
  action: TokenKeyAction
  /** The key must not reach the input (Enter would submit the form, `,` would type). */
  preventDefault: boolean
  /** The key must not reach the dialog (Escape that closed the popover). */
  stopPropagation: boolean
}

const decide = (
  action: TokenKeyAction,
  preventDefault = false,
  stopPropagation = false,
): TokenKeyDecision => ({ action, preventDefault, stopPropagation })

const NONE = decide({ type: 'none' })

const wrap = (index: number, length: number): number => ((index % length) + length) % length

/** What pressing the active row does, if anything. */
const activate = (row: TokenInputRow | undefined): TokenKeyAction => {
  if (!row) return { type: 'none' }
  if (row.kind === 'create') return { type: 'create', text: row.text }
  if (row.option.disabled) return { type: 'none' }
  return { type: 'toggle', id: row.option.id }
}

const commit = (state: TokenKeyState): TokenKeyDecision => {
  const active = state.activeIndex === null ? undefined : state.rows[state.activeIndex]
  if (active) return decide(activate(active), true)
  const exact = exactOptionMatch(state.options, state.query)
  if (exact) return decide(exact.disabled ? { type: 'none' } : { type: 'add', id: exact.id }, true)
  const text = state.query.trim()
  if (text !== '' && state.canCreate) return decide({ type: 'create', text }, true)
  return decide({ type: 'none' }, true)
}

export const decideTokenKey = (key: string, state: TokenKeyState): TokenKeyDecision => {
  switch (key) {
    case 'ArrowDown':
    case 'ArrowUp': {
      const down = key === 'ArrowDown'
      const length = state.rows.length
      if (!state.open) {
        return decide({ type: 'open', activeIndex: length === 0 ? null : down ? 0 : length - 1 }, true)
      }
      if (length === 0) return decide({ type: 'none' }, true)
      const next = state.activeIndex === null
        ? (down ? 0 : length - 1)
        : wrap(state.activeIndex + (down ? 1 : -1), length)
      return decide({ type: 'move', activeIndex: next }, true)
    }
    case 'Enter':
    case ',':
      return commit(state)
    case 'Backspace': {
      if (state.query !== '') return NONE
      if (state.highlightedTokenId !== null) {
        return decide({ type: 'remove-token', id: state.highlightedTokenId }, true)
      }
      const last = [...state.tokens].reverse().find((token) => token.removable !== false)
      return last ? decide({ type: 'highlight-token', id: last.id }, true) : NONE
    }
    case 'Escape':
      return state.open ? decide({ type: 'close' }, true, true) : NONE
    case 'Tab':
      return state.open ? decide({ type: 'close' }) : NONE
    default:
      return NONE
  }
}
