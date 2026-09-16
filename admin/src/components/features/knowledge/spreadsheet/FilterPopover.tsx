import { useMemo, useState, type RefObject } from 'react'
import { columnIndexToLabel } from '@nessie/schemas'
import { Checkbox } from '../../../primitives/Checkbox'
import { Input, Select } from '../../../shared/FormControls'
import { Popover } from '../../../overlays/Popover'
import type { SpreadsheetFilterCriterion } from '../../../../facades/knowledge/spreadsheet-hooks'

/**
 * One column's filter, in Google Sheets' shape. Checked against Sheets,
 * 2026-09-16:
 *
 *  - the funnel opens a panel offering, in order, sort this column, filter by
 *    condition, and filter by values,
 *  - "filter by values" is a checklist of the *distinct formatted values* in
 *    the column below the header, with a search box that narrows the list and
 *    "Select all" / "Clear" acting on **the narrowed list only** — that detail
 *    is what makes "search for 2025, select all" a usable gesture,
 *  - blanks are their own entry at the end rather than an empty row,
 *  - the panel commits on OK and abandons on Cancel; nothing filters while the
 *    checkboxes are being ticked.
 *
 * Applying is a server call (the same implementation `sheet_filter` uses), and
 * re-application is explicit — editing a value does not re-filter until asked,
 * so a row never vanishes under the cursor.
 */

const CONDITIONS: { label: string; op: Extract<SpreadsheetFilterCriterion, { kind: 'condition' }>['op']; operands: 0 | 1 | 2 }[] = [
  { label: 'Is empty', op: 'empty', operands: 0 },
  { label: 'Is not empty', op: 'notEmpty', operands: 0 },
  { label: 'Text contains', op: 'contains', operands: 1 },
  { label: 'Text does not contain', op: 'notContains', operands: 1 },
  { label: 'Text starts with', op: 'startsWith', operands: 1 },
  { label: 'Text ends with', op: 'endsWith', operands: 1 },
  { label: 'Is equal to', op: 'eq', operands: 1 },
  { label: 'Is not equal to', op: 'ne', operands: 1 },
  { label: 'Greater than', op: 'gt', operands: 1 },
  { label: 'Greater than or equal to', op: 'gte', operands: 1 },
  { label: 'Less than', op: 'lt', operands: 1 },
  { label: 'Less than or equal to', op: 'lte', operands: 1 },
  { label: 'Is between', op: 'between', operands: 2 },
]

type FilterPopoverProps = {
  anchorRef: RefObject<HTMLElement | null>
  column: number
  /** Every distinct formatted value in the column, blanks excluded. */
  columnValues: string[]
  criterion?: SpreadsheetFilterCriterion
  /** The column's header text when the range has a header row. */
  headerLabel?: string
  onApply: (criterion: SpreadsheetFilterCriterion) => void
  onClear: () => void
  onClose: () => void
  onSort?: (direction: 'asc' | 'desc') => void
  open: boolean
}

export const FilterPopover = ({
  anchorRef,
  column,
  columnValues,
  criterion,
  headerLabel,
  onApply,
  onClear,
  onClose,
  onSort,
  open,
}: FilterPopoverProps) => {
  const [mode, setMode] = useState<'condition' | 'values'>(
    criterion?.kind === 'condition' ? 'condition' : 'values',
  )
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(criterion?.kind === 'values' ? criterion.values : columnValues),
  )
  const [blanks, setBlanks] = useState(criterion?.kind === 'values' ? criterion.blanks : true)
  const [op, setOp] = useState<Extract<SpreadsheetFilterCriterion, { kind: 'condition' }>['op']>(
    criterion?.kind === 'condition' ? criterion.op : 'contains',
  )
  const [value, setValue] = useState(criterion?.kind === 'condition' ? criterion.value : '')
  const [value2, setValue2] = useState(
    criterion?.kind === 'condition' ? criterion.value2 ?? '' : '',
  )

  const narrowed = useMemo(() => {
    const needle = search.trim().toLowerCase()
    return needle
      ? columnValues.filter((entry) => entry.toLowerCase().includes(needle))
      : columnValues
  }, [columnValues, search])

  const operands = CONDITIONS.find((condition) => condition.op === op)?.operands ?? 1
  const title = headerLabel?.trim() || `Column ${columnIndexToLabel(column)}`

  const toggleNarrowed = (next: boolean) => {
    setSelected((current) => {
      const updated = new Set(current)
      // Sheets acts on the narrowed list, not the whole column: that is what
      // makes "search, then select all" mean "only these".
      for (const entry of narrowed) {
        if (next) updated.add(entry)
        else updated.delete(entry)
      }
      return updated
    })
  }

  return (
    <Popover
      anchorRef={anchorRef}
      // `Popover` places and dismisses; the panel's own chrome is the caller's,
      // as it is at every other call site. Without it the panel is transparent
      // and the grid reads straight through the checklist.
      className="w-80 overflow-auto rounded-lg border border-[color:var(--sep)] bg-[color:var(--panel)] p-3 shadow-lg"
      label={`Filter ${title}`}
      onClose={onClose}
      open={open}
      placement="bottom-start"
    >
      {/* `min-w-0` on the grid container, not only on the input inside it:
          a grid whose `min-width` is `auto` sizes to its own items' min-content
          and overflows the scroll panel around it, which `overflow: auto` then
          turns into a clip -- the step button and "Replace all" were simply
          outside the panel and unclickable. */}
      <div className="grid min-w-0 gap-3" data-testid="spreadsheet-filter-popover">
        <div className="text-xs font-semibold text-[color:var(--tx3)]">{title}</div>

        {onSort ? (
          <div className="flex gap-2">
            <button
              className="admin-button admin-button-secondary admin-button-compact flex-1"
              onClick={() => onSort('asc')}
              type="button"
            >
              Sort A → Z
            </button>
            <button
              className="admin-button admin-button-secondary admin-button-compact flex-1"
              onClick={() => onSort('desc')}
              type="button"
            >
              Sort Z → A
            </button>
          </div>
        ) : null}

        <Select
          aria-label="Filter kind"
          onChange={(event) => setMode(event.target.value === 'condition' ? 'condition' : 'values')}
          size="compact"
          value={mode}
        >
          <option value="values">Filter by values</option>
          <option value="condition">Filter by condition</option>
        </Select>

        {mode === 'values' ? (
          <div className="grid gap-2">
            <Input
              aria-label="Search values"
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search…"
              size="compact"
              type="search"
              value={search}
            />
            <div className="flex gap-2 text-xs">
              <button
                className="underline text-[color:var(--accent)]"
                onClick={() => toggleNarrowed(true)}
                type="button"
              >
                Select all
              </button>
              <button
                className="underline text-[color:var(--accent)]"
                onClick={() => toggleNarrowed(false)}
                type="button"
              >
                Clear
              </button>
            </div>
            <div className="grid max-h-56 gap-1 overflow-y-auto rounded border border-[color:var(--sep)] p-2">
              {narrowed.map((entry) => (
                <Checkbox
                  checked={selected.has(entry)}
                  key={entry}
                  label={entry}
                  onChange={(next) =>
                    setSelected((current) => {
                      const updated = new Set(current)
                      if (next) updated.add(entry)
                      else updated.delete(entry)
                      return updated
                    })
                  }
                />
              ))}
              {search.trim() ? null : (
                <Checkbox checked={blanks} label="(Blanks)" onChange={setBlanks} />
              )}
              {narrowed.length === 0 ? (
                <p className="text-xs text-[color:var(--tx3)]">No matching values</p>
              ) : null}
            </div>
          </div>
        ) : (
          <div className="grid gap-2">
            <Select
              aria-label="Condition"
              onChange={(event) =>
                setOp(event.target.value as typeof op)}
              size="compact"
              value={op}
            >
              {CONDITIONS.map((condition) => (
                <option key={condition.op} value={condition.op}>{condition.label}</option>
              ))}
            </Select>
            {operands >= 1 ? (
              <Input
                aria-label="Value"
                onChange={(event) => setValue(event.target.value)}
                placeholder="Value"
                size="compact"
                value={value}
              />
            ) : null}
            {operands === 2 ? (
              <Input
                aria-label="And value"
                onChange={(event) => setValue2(event.target.value)}
                placeholder="and"
                size="compact"
                value={value2}
              />
            ) : null}
          </div>
        )}

        <div className="flex justify-end gap-2">
          {criterion ? (
            <button
              className="admin-button admin-button-secondary admin-button-compact mr-auto"
              onClick={onClear}
              type="button"
            >
              Clear filter
            </button>
          ) : null}
          <button
            className="admin-button admin-button-secondary admin-button-compact"
            onClick={onClose}
            type="button"
          >
            Cancel
          </button>
          <button
            className="admin-button admin-button-primary admin-button-compact"
            data-testid="spreadsheet-filter-apply"
            onClick={() =>
              onApply(
                mode === 'values'
                  ? { blanks, kind: 'values', values: [...selected] }
                  : { kind: 'condition', op, value, ...(operands === 2 ? { value2 } : {}) },
              )
            }
            type="button"
          >
            OK
          </button>
        </div>
      </div>
    </Popover>
  )
}
