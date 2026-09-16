import { useRef, useState } from 'react'
import { Dialog } from '../../../shared/Dialog'
import { FormField } from '../../../shared/FormField'
import { Input } from '../../../shared/FormControls'

/**
 * “New spreadsheet”. A title and nothing else: an empty workbook with one sheet
 * is what the server creates, and every other decision — sheets, size, format —
 * belongs in the grid, not in a setup form.
 */
export const SpreadsheetCreateDialog = ({
  onClose,
  onSubmit,
  open,
  pending = false,
}: {
  onClose: () => void
  onSubmit: (title: string) => void
  open: boolean
  pending?: boolean
}) => {
  const [title, setTitle] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const trimmed = title.trim()

  return (
    <Dialog
      dismissDisabled={pending}
      initialFocusRef={inputRef}
      onClose={onClose}
      open={open}
      title="New spreadsheet"
    >
      <form
        className="grid gap-4 pt-3"
        data-testid="spreadsheet-create-dialog"
        onSubmit={(event) => {
          event.preventDefault()
          if (trimmed) onSubmit(trimmed)
        }}
      >
        <FormField label="Title">
          <Input
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Q3 Forecast"
            ref={inputRef}
            value={title}
          />
        </FormField>
        <div className="flex justify-end gap-2">
          <button
            className="admin-button admin-button-secondary"
            disabled={pending}
            onClick={onClose}
            type="button"
          >
            Cancel
          </button>
          <button
            className="admin-button admin-button-primary"
            data-testid="spreadsheet-create-submit"
            disabled={!trimmed || pending}
            type="submit"
          >
            Create
          </button>
        </div>
      </form>
    </Dialog>
  )
}
