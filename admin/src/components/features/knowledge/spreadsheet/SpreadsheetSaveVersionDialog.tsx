import { useRef, useState } from 'react'
import { Dialog } from '../../../shared/Dialog'
import { FormField } from '../../../shared/FormField'
import { Input } from '../../../shared/FormControls'

/**
 * “Save version”. The comment is the only field, and it is optional in the
 * contract but asked for here, because a version list whose entries all read
 * “compaction” is a list nobody restores from.
 *
 * There is no retention policy and no approval gate: a version saved here is
 * reachable forever, and that is the whole of this feature's safety story.
 */
export const SpreadsheetSaveVersionDialog = ({
  onClose,
  onSubmit,
  open,
  pending = false,
}: {
  onClose: () => void
  onSubmit: (changeComment: string) => void
  open: boolean
  pending?: boolean
}) => {
  const [comment, setComment] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  return (
    <Dialog
      dismissDisabled={pending}
      initialFocusRef={inputRef}
      onClose={onClose}
      open={open}
      title="Save a version"
    >
      <form
        className="grid gap-4 pt-3"
        data-testid="spreadsheet-save-version-dialog"
        onSubmit={(event) => {
          event.preventDefault()
          onSubmit(comment.trim() || 'named version')
        }}
      >
        <FormField
          help="What this version is, so the list is readable a month from now."
          label="Comment"
        >
          <Input
            onChange={(event) => setComment(event.target.value)}
            placeholder="Before the Q4 re-forecast"
            ref={inputRef}
            value={comment}
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
            data-testid="spreadsheet-save-version-submit"
            disabled={pending}
            type="submit"
          >
            Save version
          </button>
        </div>
      </form>
    </Dialog>
  )
}
