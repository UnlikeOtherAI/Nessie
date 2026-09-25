import { useEffect, useState, type FormEvent } from 'react'
import type { KnowledgePageRecord } from '../../../facades/knowledge/hooks'
import { useRenamePage } from '../../../facades/knowledge/finder-hooks'
import { toFormErrors } from '../../../facades/forms/form-errors'
import { Dialog } from '../../shared/Dialog'
import { FormActions, FormError } from '../../shared/FormActions'
import { FormField } from '../../shared/FormField'
import { Input } from '../../shared/FormControls'

type FolderSettingsDialogProps = {
  folder: KnowledgePageRecord
  onClose: () => void
  open: boolean
  spaceId: string
}

/** Settings for the folder the Finder is standing in, not its containing space. */
export const FolderSettingsDialog = ({
  folder,
  onClose,
  open,
  spaceId,
}: FolderSettingsDialogProps) => {
  const rename = useRenamePage()
  const [name, setName] = useState(folder.title)
  const [error, setError] = useState<string | undefined>()

  useEffect(() => {
    if (!open) return
    setName(folder.title)
    setError(undefined)
  }, [folder.id, folder.title, open])

  if (!open) return null

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const title = name.trim()
    if (!title) return
    setError(undefined)
    rename.mutate(
      { pageId: folder.id, revision: folder.revision, spaceId, title },
      {
        onError: (failure) => setError(
          toFormErrors(failure).formError ?? 'Unable to rename this folder.',
        ),
        onSuccess: onClose,
      },
    )
  }

  return (
    <Dialog onClose={onClose} open={open} title="Folder settings">
      <form className="grid gap-4" onSubmit={submit}>
        <FormField label="Name" required>
          <Input
            autoComplete="off"
            autoFocus
            onChange={(event) => {
              setName(event.target.value)
              setError(undefined)
            }}
            value={name}
          />
        </FormField>
        <p className="text-sm text-[color:var(--tx3)]">
          Access is inherited from the containing document space.
        </p>
        <FormError>{error}</FormError>
        <FormActions>
          <button className="admin-button admin-button-secondary" onClick={onClose} type="button">
            Cancel
          </button>
          <button
            className="admin-button admin-button-primary"
            disabled={!name.trim() || rename.isPending}
            type="submit"
          >
            {rename.isPending ? 'Saving…' : 'Save'}
          </button>
        </FormActions>
      </form>
    </Dialog>
  )
}
