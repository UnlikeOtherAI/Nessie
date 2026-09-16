/**
 * The Finder's selection model, as a pure reducer (browser-ui.md §7).
 *
 * It is pure and separate from the components because the interesting parts —
 * what a Shift-click means after a Cmd-click, what happens to the selection
 * when the column you were in is no longer there — are decisions, not
 * rendering, and a decision that lives inside a component is one that can only
 * be checked by driving a browser.
 *
 * The model: one *active* column, a set of selected ids inside it, and an
 * anchor for Shift ranges. Every other column's "selection" is the path — the
 * one folder you came through — and is derived by the browser from the open
 * path rather than stored here, so the two can never disagree.
 */

export type FinderSelection = {
  /** The column that the toolbar acts on and that paints an accent pill. */
  columnKey: string
  /** Selected ids in that column, in the column's own order. */
  ids: readonly string[]
  /** Where a Shift range measures from. */
  anchorId: string | null
}

export type FinderClickModifier = 'none' | 'toggle' | 'range'

export type FinderStep = number | 'home' | 'end'

export type FinderSelectionEvent =
  | {
      type: 'click'
      columnKey: string
      id: string
      modifier: FinderClickModifier
      /** The column's rows in the order they are drawn. */
      order: readonly string[]
    }
  | { type: 'selectAll'; columnKey: string; order: readonly string[] }
  | { type: 'step'; columnKey: string; order: readonly string[]; step: FinderStep; extend: boolean }
  | { type: 'focusColumn'; columnKey: string }
  /** A folder was opened: its column becomes active with nothing selected. */
  | { type: 'enterColumn'; columnKey: string }
  | { type: 'clear' }
  /** The rows changed under us (a delete, a refetch, a different folder). */
  | { type: 'reconcile'; columnKey: string; order: readonly string[] }

export const emptyFinderSelection = (columnKey = ''): FinderSelection => ({
  anchorId: null,
  columnKey,
  ids: [],
})

/** Ids kept in the column's own order, so a Shift range reads left to right. */
const inOrder = (order: readonly string[], ids: Iterable<string>): string[] => {
  const wanted = new Set(ids)
  return order.filter((id) => wanted.has(id))
}

const rangeBetween = (
  order: readonly string[],
  anchorId: string | null,
  id: string,
): string[] => {
  const to = order.indexOf(id)
  if (to < 0) return []
  const from = anchorId === null ? to : order.indexOf(anchorId)
  if (from < 0) return [id]
  const [low, high] = from <= to ? [from, to] : [to, from]
  return order.slice(low, high + 1)
}

const stepTo = (order: readonly string[], current: string | null, step: FinderStep): string | null => {
  if (order.length === 0) return null
  if (step === 'home') return order[0] ?? null
  if (step === 'end') return order[order.length - 1] ?? null
  const at = current === null ? -1 : order.indexOf(current)
  // Arriving in a column with nothing selected: ↓ lands on the first row and
  // ↑ on the last, which is what every list in this admin already does.
  if (at < 0) return (step > 0 ? order[0] : order[order.length - 1]) ?? null
  const next = Math.min(order.length - 1, Math.max(0, at + step))
  return order[next] ?? null
}

export const finderSelectionReducer = (
  state: FinderSelection,
  event: FinderSelectionEvent,
): FinderSelection => {
  switch (event.type) {
    case 'click': {
      // A click in another column moves the active column first: the previous
      // column's selection is not extended by it, it is replaced.
      const sameColumn = state.columnKey === event.columnKey
      if (event.modifier === 'toggle' && sameColumn) {
        const held = new Set(state.ids)
        if (held.has(event.id)) held.delete(event.id)
        else held.add(event.id)
        const ids = inOrder(event.order, held)
        return {
          anchorId: held.has(event.id) ? event.id : (ids.at(-1) ?? null),
          columnKey: event.columnKey,
          ids,
        }
      }
      if (event.modifier === 'range' && sameColumn) {
        return {
          // The anchor stays put, so a second Shift-click re-measures from the
          // same place rather than creeping along behind the pointer.
          anchorId: state.anchorId ?? event.id,
          columnKey: event.columnKey,
          ids: rangeBetween(event.order, state.anchorId, event.id),
        }
      }
      return { anchorId: event.id, columnKey: event.columnKey, ids: [event.id] }
    }

    case 'selectAll':
      return {
        anchorId: event.order[0] ?? null,
        columnKey: event.columnKey,
        ids: [...event.order],
      }

    case 'step': {
      const sameColumn = state.columnKey === event.columnKey
      const cursor = sameColumn ? (state.ids.at(-1) ?? null) : null
      const next = stepTo(event.order, cursor, event.step)
      if (next === null) return state
      if (event.extend && sameColumn) {
        const anchorId = state.anchorId ?? cursor ?? next
        return {
          anchorId,
          columnKey: event.columnKey,
          ids: rangeBetween(event.order, anchorId, next),
        }
      }
      return { anchorId: next, columnKey: event.columnKey, ids: [next] }
    }

    case 'focusColumn':
      if (state.columnKey === event.columnKey) return state
      return { anchorId: null, columnKey: event.columnKey, ids: [] }

    case 'enterColumn':
      return { anchorId: null, columnKey: event.columnKey, ids: [] }

    case 'clear':
      if (state.ids.length === 0) return state
      return { anchorId: null, columnKey: state.columnKey, ids: [] }

    case 'reconcile': {
      if (state.columnKey !== event.columnKey) return state
      const ids = inOrder(event.order, state.ids)
      if (ids.length === state.ids.length && ids.every((id, at) => id === state.ids[at])) {
        // Identity matters: this runs on every page-list refetch, and a fresh
        // array would re-render every column that reads the selection.
        return state
      }
      return {
        anchorId: state.anchorId && ids.includes(state.anchorId) ? state.anchorId : (ids[0] ?? null),
        columnKey: state.columnKey,
        ids,
      }
    }
  }
}

/**
 * What a click means. Cmd/Ctrl toggles, Shift extends, a plain click replaces
 * — the modifiers every file browser uses, and deliberately *not* the ones a
 * drag reads: ⌥ is copy, and nothing else is a modifier.
 */
export const clickModifier = (event: {
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
}): FinderClickModifier =>
  event.shiftKey ? 'range' : event.metaKey || event.ctrlKey ? 'toggle' : 'none'

/** The row a column paints as selected, including the inactive grey ones. */
export const isRowSelected = (
  selection: FinderSelection,
  columnKey: string,
  id: string,
  pathSelectionId?: string,
): boolean =>
  selection.columnKey === columnKey
    ? selection.ids.includes(id)
    : pathSelectionId === id
