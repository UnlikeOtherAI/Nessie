import { useState } from 'react'
import { Dialog } from '../../../shared/Dialog'
import { Notice } from '../../../primitives/Notice'
import { Select } from '../../../shared/FormControls'
import { FormField } from '../../../shared/FormField'

/**
 * Export. Two formats, and the one sentence a person needs before they send the
 * file to somebody: **an xlsx carries the hidden rows a filter produced, but not
 * the filter itself.** IronCalc 0.8 has no autofilter object to write, so the
 * receiver opens a workbook with rows mysteriously missing unless they are told.
 * Saying it here is cheaper than the support conversation.
 */
export const SpreadsheetExportDialog = ({
  filtered,
  onClose,
  onExport,
  open,
  sheets,
}: {
  /** The active sheet carries a filter, so the xlsx caveat applies. */
  filtered: boolean
  onClose: () => void
  onExport: (input: { format: 'csv' | 'xlsx'; sheet?: number }) => void
  open: boolean
  sheets: { index: number; name: string }[]
}) => {
  const [format, setFormat] = useState<'csv' | 'xlsx'>('xlsx')
  const [sheet, setSheet] = useState<number>(sheets[0]?.index ?? 0)

  return (
    <Dialog onClose={onClose} open={open} title="Export spreadsheet">
      <div className="grid gap-4 pt-3" data-testid="spreadsheet-export-dialog">
        <FormField label="Format">
          <Select
            onChange={(event) => setFormat(event.target.value === 'csv' ? 'csv' : 'xlsx')}
            value={format}
          >
            <option value="xlsx">Excel workbook (.xlsx) — every sheet</option>
            <option value="csv">CSV (.csv) — one sheet, values as displayed</option>
          </Select>
        </FormField>

        {format === 'csv' ? (
          <FormField label="Sheet">
            <Select onChange={(event) => setSheet(Number(event.target.value))} value={String(sheet)}>
              {sheets.map((entry) => (
                <option key={entry.index} value={entry.index}>{entry.name}</option>
              ))}
            </Select>
          </FormField>
        ) : null}

        {format === 'xlsx' && filtered ? (
          <Notice size="sm" tone="warning">
            The rows this filter hides stay hidden in the file, but the filter
            itself is not written — whoever opens it will not see why.
          </Notice>
        ) : null}

        <div className="flex justify-end gap-2">
          <button className="admin-button admin-button-secondary" onClick={onClose} type="button">
            Cancel
          </button>
          <button
            className="admin-button admin-button-primary"
            data-testid="spreadsheet-export-submit"
            onClick={() => onExport(format === 'csv' ? { format, sheet } : { format })}
            type="button"
          >
            Download
          </button>
        </div>
      </div>
    </Dialog>
  )
}
