import { useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
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
  const { t } = useTranslation('settings')
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
      void navigate(`/settings/statuses/${created.id}`)
    } catch (cause) {
      const { fieldErrors, formError } = toFormErrors(cause)
      setError(fieldErrors.label ?? formError ?? t('statuses.createFailed'))
    }
  }

  return (
    <Dialog
      description={t('statuses.createDescription')}
      dismissDisabled={createStatus.isPending}
      onClose={close}
      open={open}
      title={t('statuses.newStatus')}
    >
      <form className="grid gap-4" onSubmit={submit}>
        <div className="grid grid-cols-[90px_minmax(0,1fr)] gap-2">
          <FormField label={t('statuses.icon')}>
            <StatusEmojiPicker label={t('statuses.newStatusIcon')} onChange={setEmoji} value={emoji} />
          </FormField>
          <FormField label={t('statuses.label')}>
            <Input
              onChange={(event) => setLabel(event.target.value)}
              placeholder={t('statuses.labelPlaceholder')}
              value={label}
            />
          </FormField>
        </div>
        <FormError>{error}</FormError>
        <FormActions>
          <button className="admin-button admin-button-secondary" onClick={close} type="button">
            {t('common.cancel')}
          </button>
          <button
            className="admin-button admin-button-primary"
            disabled={!label.trim() || createStatus.isPending}
            type="submit"
          >
            {createStatus.isPending ? t('statuses.adding') : t('statuses.addStatus')}
          </button>
        </FormActions>
      </form>
    </Dialog>
  )
}
