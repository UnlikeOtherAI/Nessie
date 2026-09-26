import { useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { useCreateStatus } from '../../../facades/statuses/hooks'
import { toFormErrors } from '../../../facades/forms/form-errors'
import { Dialog } from '../../../components/shared/Dialog'
import { FormActions, FormError } from '../../../components/shared/FormActions'
import { FormField } from '../../../components/shared/FormField'
import { Input } from '../../../components/shared/FormControls'
import { StatusEmojiPicker } from './StatusEmojiPicker'

type CreateStatusDialogProps = {
  onClose: () => void
  open: boolean
}

/**
 * Adding a status. It was an inline form pinned above the list, which put a
 * form somebody uses once above the list they came to read; a new status opens
 * its own screen anyway, where the schedules and contact rules that make it
 * worth having actually live.
 */
export const CreateStatusDialog = ({ onClose, open }: CreateStatusDialogProps) => {
  const navigate = useNavigate()
  const createStatus = useCreateStatus()
  const [label, setLabel] = useState('')
  const [emoji, setEmoji] = useState('')
  const [error, setError] = useState<string | undefined>(undefined)

  const close = () => {
    setLabel('')
    setEmoji('')
    setError(undefined)
    onClose()
  }

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!label.trim()) return
    setError(undefined)
    try {
      const created = await createStatus.mutateAsync({
        emoji: emoji.trim() || null,
        label: label.trim(),
      })
      close()
      void navigate(`/settings/status/${created.id}`)
    } catch (cause) {
      const { fieldErrors, formError } = toFormErrors(cause)
      setError(fieldErrors.label ?? formError ?? 'Failed to create status.')
    }
  }

  return (
    <Dialog
      description="A status says what you are doing. Its schedules and contact rules are set on its own screen."
      dismissDisabled={createStatus.isPending}
      onClose={close}
      open={open}
      title="New status"
    >
      <form className="grid gap-4" onSubmit={submit}>
        <div className="grid grid-cols-[90px_minmax(0,1fr)] gap-2">
          <FormField label="Icon">
            <StatusEmojiPicker label="New status icon" onChange={setEmoji} value={emoji} />
          </FormField>
          <FormField label="Label">
            <Input
              onChange={(event) => setLabel(event.target.value)}
              placeholder="e.g. Heads down"
              value={label}
            />
          </FormField>
        </div>
        <FormError>{error}</FormError>
        <FormActions>
          <button className="admin-button admin-button-secondary" onClick={close} type="button">
            Cancel
          </button>
          <button
            className="admin-button admin-button-primary"
            disabled={!label.trim() || createStatus.isPending}
            type="submit"
          >
            {createStatus.isPending ? 'Adding…' : 'Add status'}
          </button>
        </FormActions>
      </form>
    </Dialog>
  )
}
