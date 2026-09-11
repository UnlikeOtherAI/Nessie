import { useEffect, useRef, useState, type FormEvent } from 'react'
import { ApiClientError } from '@nessie/client-core'
import { CONVERSATION_TITLE_MAX_CHARS, type AgentConversationRecord } from '@nessie/schemas'
import { useRenameThread } from '../../../facades/threads/hooks'
import { Dialog } from '../../shared/Dialog'
import { FormActions, FormError } from '../../shared/FormActions'
import { FormField } from '../../shared/FormField'
import { Input } from '../../shared/FormControls'
import { canSaveConversationTitle } from './rename-conversation'

type RenameConversationDialogProps = {
  /** The conversation on screen; null closes the dialog out of harm's way. */
  conversation: AgentConversationRecord | null
  onClose: () => void
  open: boolean
}

/**
 * Renaming the open conversation, from the header that shows its name.
 *
 * The refusals are the server's, rendered rather than pre-empted: a viewer who
 * is neither the starter nor a channel manager gets 403, a thread that has
 * gone gets 404, and a room's General thread gets 400 `THREAD_TITLE_FIXED`.
 * Only the last of those is unreachable from here (the header offers no rename
 * on a General thread), and it still renders its message instead of being
 * swallowed — a refusal nobody can read is the same defect as no doorway.
 *
 * A refusal belongs on the field, because the field is what has to change; a
 * network failure does not, so it is a `Notice` for the dialog. Either way the
 * dialog stays open with the typed title intact.
 */
export const RenameConversationDialog = ({
  conversation,
  onClose,
  open,
}: RenameConversationDialogProps) => {
  const renameThread = useRenameThread()
  const currentTitle = conversation?.title ?? ''
  const [title, setTitle] = useState(currentTitle)
  const [fieldError, setFieldError] = useState<string | undefined>()
  const [noticeError, setNoticeError] = useState<string | undefined>()
  const inputRef = useRef<HTMLInputElement>(null)

  // Opening is what seeds the field, not rendering: the whole point of the
  // dialog is to edit the name that is there now, and the first thing most
  // renames do is replace it — so the text arrives selected.
  useEffect(() => {
    if (!open) return
    setTitle(currentTitle)
    setFieldError(undefined)
    setNoticeError(undefined)
    const input = inputRef.current
    if (input) {
      input.focus()
      input.select()
    }
    // `currentTitle` is deliberately absent: a rename that lands while the
    // dialog is open must not reach in and retype the field.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const saveEnabled = canSaveConversationTitle({
    current: currentTitle,
    next: title,
    pending: renameThread.isPending,
  })

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!conversation || !saveEnabled) return
    setFieldError(undefined)
    setNoticeError(undefined)
    try {
      await renameThread.mutateAsync({ threadId: conversation.id, title: title.trim() })
      onClose()
    } catch (error) {
      // The server's own sentence, on the field it is about. Anything that
      // never reached the server (offline, a dropped connection) is not about
      // the field at all.
      if (error instanceof ApiClientError) {
        setFieldError(error.message || 'This conversation could not be renamed.')
        return
      }
      setNoticeError('The rename could not be sent. Check your connection and try again.')
    }
  }

  return (
    <Dialog
      initialFocusRef={inputRef}
      onClose={onClose}
      open={open && conversation !== null}
      title="Rename conversation"
    >
      <form className="grid gap-4" onSubmit={handleSubmit}>
        <FormField
          error={fieldError}
          help="Anyone who can see this conversation sees the name."
          label="Name"
          required
        >
          <Input
            autoComplete="off"
            maxLength={CONVERSATION_TITLE_MAX_CHARS}
            onChange={(event) => {
              setTitle(event.target.value)
              setFieldError(undefined)
              setNoticeError(undefined)
            }}
            ref={inputRef}
            value={title}
          />
        </FormField>

        <FormError>{noticeError}</FormError>

        <FormActions>
          <button className="admin-button admin-button-secondary" onClick={onClose} type="button">
            Cancel
          </button>
          <button
            className="admin-button admin-button-primary"
            disabled={!saveEnabled}
            type="submit"
          >
            Save
          </button>
        </FormActions>
      </form>
    </Dialog>
  )
}
