import { useState } from 'react'
import { faPlus, faXmark } from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import {
  columnIndexToLabel,
  formatA1Range,
  type SpreadsheetSelection,
} from '@nessie/schemas'
import { Checkbox } from '../../../primitives/Checkbox'
import { Dialog } from '../../../shared/Dialog'
import { Select } from '../../../shared/FormControls'
import { Notice } from '../../../primitives/Notice'
import type { SpreadsheetSortRequest } from '../../../../facades/knowledge/spreadsheet-hooks'

/**
 * Google Sheets' "Advanced range sorting options", which is the interaction
 * model this feature copies. Checked against Sheets, 2026-09-16:
 *
 *  - the range is whatever is selected; the dialog names it and never guesses a
 *    wider one,
 *  - "Data has header row" is a checkbox, and ticking it re-labels the sort-by
 *    dropdown from "Column B" to that header's text while keeping row 1 in
 *    place,
 *  - sort keys are ordered and additive ("Add another sort column"), each with
 *    its own A→Z / Z→A,
 *  - Sheets refuses a range containing merged cells and names them. IronCalc
 *    0.8 has no merge API at all (decisions.md §"Engine feature coverage"), so
 *    that case cannot arise here and the dialog does not pretend to check for
 *    it.
 *
 * The sort itself runs on the server — the same implementation the `sheet_sort`
 * tool calls — so a person and an agent sort identically, and it lands in the
 * journal as an ordinary batch with undo and presence for free.
 */

type SortKeyDraft = { column: number; direction: 'asc' | 'desc' }

type SpreadsheetSortDialogProps = {
  /** Header text per absolute column, when the first row is a header. */
  headerLabels?: Record<number, string>
  onClose: () => void
  onSubmit: (request: SpreadsheetSortRequest) => void
  open: boolean
  pending?: boolean
  selection: SpreadsheetSelection
  sheet: number
  sheetName: string
}

export const SpreadsheetSortDialog = ({
  headerLabels,
  onClose,
  onSubmit,
  open,
  pending = false,
  selection,
  sheet,
  sheetName,
}: SpreadsheetSortDialogProps) => {
  const [hasHeaderRow, setHasHeaderRow] = useState(true)
  const [keys, setKeys] = useState<SortKeyDraft[]>([
    { column: selection.c0, direction: 'asc' },
  ])

  const columns = Array.from(
    { length: selection.c1 - selection.c0 + 1 },
    (_, index) => selection.c0 + index,
  )
  const columnLabel = (column: number): string => {
    const header = hasHeaderRow ? headerLabels?.[column]?.trim() : undefined
    return header ? `${header} (${columnIndexToLabel(column)})` : `Column ${columnIndexToLabel(column)}`
  }
  const singleCell = selection.r0 === selection.r1 && selection.c0 === selection.c1

  return (
    <Dialog
      description={`${sheetName} · ${formatA1Range(selection)}`}
      onClose={onClose}
      open={open}
      size="lg"
      title="Sort range"
    >
      <div className="grid gap-4 p-4" data-testid="spreadsheet-sort-dialog">
        {singleCell ? (
          <Notice tone="warning">
            Only one cell is selected. Select the range you want sorted first —
            sorting a single cell would reorder nothing.
          </Notice>
        ) : null}

        <Checkbox
          checked={hasHeaderRow}
          label="Data has header row"
          onChange={setHasHeaderRow}
        />

        <div className="grid gap-2">
          {keys.map((key, index) => (
            <div className="flex items-center gap-2" key={`${key.column}-${index}`}>
              <span className="w-16 shrink-0 text-xs text-[color:var(--tx3)]">
                {index === 0 ? 'Sort by' : 'then by'}
              </span>
              <Select
                aria-label={index === 0 ? 'Sort by column' : `Then sort by column ${index + 1}`}
                className="flex-1"
                onChange={(event) => {
                  const column = Number(event.target.value)
                  setKeys((current) =>
                    current.map((item, at) => (at === index ? { ...item, column } : item)))
                }}
                size="compact"
                value={String(key.column)}
              >
                {columns.map((column) => (
                  <option key={column} value={column}>{columnLabel(column)}</option>
                ))}
              </Select>
              <Select
                aria-label="Sort direction"
                onChange={(event) => {
                  const direction = event.target.value === 'desc' ? 'desc' : 'asc'
                  setKeys((current) =>
                    current.map((item, at) => (at === index ? { ...item, direction } : item)))
                }}
                size="compact"
                value={key.direction}
              >
                <option value="asc">A → Z</option>
                <option value="desc">Z → A</option>
              </Select>
              {keys.length > 1 ? (
                <button
                  aria-label={`Remove sort column ${index + 1}`}
                  className="admin-button admin-button-secondary admin-button-compact"
                  onClick={() => setKeys((current) => current.filter((_, at) => at !== index))}
                  type="button"
                >
                  <FontAwesomeIcon icon={faXmark} />
                </button>
              ) : null}
            </div>
          ))}
        </div>

        <div>
          <button
            className="admin-button admin-button-secondary admin-button-compact gap-1.5"
            disabled={keys.length >= columns.length}
            onClick={() =>
              setKeys((current) => {
                const used = new Set(current.map((key) => key.column))
                const next = columns.find((column) => !used.has(column))
                return next === undefined ? current : [...current, { column: next, direction: 'asc' }]
              })
            }
            type="button"
          >
            <FontAwesomeIcon icon={faPlus} />
            Add another sort column
          </button>
        </div>

        <p className="text-xs text-[color:var(--tx3)]">
          Formulas move with their rows the way a copy would: relative references
          shift, absolute ones stay.
        </p>

        <div className="flex justify-end gap-2">
          <button
            className="admin-button admin-button-secondary"
            onClick={onClose}
            type="button"
          >
            Cancel
          </button>
          <button
            className="admin-button admin-button-primary"
            data-testid="spreadsheet-sort-submit"
            disabled={pending || singleCell}
            onClick={() => onSubmit({ hasHeaderRow, keys, range: selection, sheet })}
            type="button"
          >
            Sort
          </button>
        </div>
      </div>
    </Dialog>
  )
}
