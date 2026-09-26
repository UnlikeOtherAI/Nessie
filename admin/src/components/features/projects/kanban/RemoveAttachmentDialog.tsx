import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  TASK_ATTACHMENT_REMOVE_REASON_MAX_CHARS,
  type TaskAttachmentRecord,
} from '@nessie/schemas'
import { Notice } from '../../../primitives/Notice'
import { Dialog } from '../../../shared/Dialog'
import { FormField } from '../../../shared/FormField'
import { Textarea } from '../../../shared/FormControls'

type RemoveAttachmentDialogProps = {
  /** The file being removed; null keeps the dialog closed. */
  attachment: TaskAttachmentRecord | null
  /** A failure other than "somebody else already removed it" — shown in place. */
  error?: string | null
  onCancel: () => void
  onConfirm: (reason: string) => void
  pending?: boolean
}

/**
 * The confirm before a ticket file is marked removed
 * (board-labels-and-attachment-removal.md §9.6). Always asked, not only for an
 * inline image, because the one thing a person can add here — why — is only
 * worth anything if it is offered every time.
 *
 * On the shared `Dialog` rather than `ConfirmDialog`, which has no field. It
 * opens over the task dialog, so it is the sanctioned `blocking` nesting.
 */
export const RemoveAttachmentDialog = ({
  attachment,
  error,
  onCancel,
  onConfirm,
  pending = false,
}: RemoveAttachmentDialogProps) => {
  const { t } = useTranslation('projects')
  const reasonRef = useRef<HTMLTextAreaElement>(null)
  const [reason, setReason] = useState('')
  const open = attachment !== null

  // A fresh reason for every file: text typed for one never rides another.
  useEffect(() => {
    if (open) setReason('')
  }, [attachment?.id, open])

  const submit = () => {
    if (!pending) onConfirm(reason)
  }

  const where = attachment?.commentId ? t('attachments.comment') : t('attachments.description')

  return (
    <Dialog
      blocking
      dismissDisabled={pending}
      initialFocusRef={reasonRef}
      onClose={onCancel}
      open={open}
      title={attachment ? t('attachments.removeTitle', { name: attachment.filename }) : t('attachments.removeFileTitle')}
    >
      <div className="grid gap-4" data-testid="remove-attachment-dialog">
        <div className="grid gap-1 text-sm text-[color:var(--tx3)]">
          <p>{t('attachments.removeBody')}</p>
          {attachment?.inline ? <p>{t('attachments.inlineBody', { where })}</p> : null}
        </div>
        <FormField
          help={(
            <span className="flex items-center justify-between gap-3">
              <span>{t('attachments.optionalReason')}</span>
              <span data-testid="remove-attachment-reason-count">
                {reason.length}/{TASK_ATTACHMENT_REMOVE_REASON_MAX_CHARS}
              </span>
            </span>
          )}
          label={t('attachments.reason')}
        >
          <Textarea
            aria-label={t('attachments.reason')}
            disabled={pending}
            maxLength={TASK_ATTACHMENT_REMOVE_REASON_MAX_CHARS}
            onChange={(event) => setReason(event.target.value)}
            onKeyDown={(event) => {
              // Enter is a newline; ⌘/Ctrl+Enter removes, as the comment composer posts.
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault()
                submit()
              }
            }}
            ref={reasonRef}
            rows={3}
            value={reason}
          />
        </FormField>
        {error ? <Notice role="alert" size="sm" tone="danger">{error}</Notice> : null}
      </div>

      <div className="flex justify-end gap-2 pt-5">
        <button
          className="admin-button admin-button-secondary"
          disabled={pending}
          onClick={onCancel}
          type="button"
        >
          {t('attachments.cancel')}
        </button>
        <button
          className="admin-button admin-button-danger"
          data-testid="remove-attachment-confirm"
          disabled={pending}
          onClick={submit}
          type="button"
        >
          {t('attachments.remove')}
        </button>
      </div>
    </Dialog>
  )
}
