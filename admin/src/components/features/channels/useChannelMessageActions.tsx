import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { detectSecrets } from '@nessie/schemas'
import { ConfirmDialog } from '../../shared/ConfirmDialog'
import { SecretCaptureDialog } from './SecretCaptureDialog'
import { draftKey, useDraft } from '../../../navigation/useDraft'
import {
  useAddMessageReaction,
  useDeleteMessage,
  useUpdateMessage,
} from '../../../facades/messages/hooks'
import type { SecretRecord } from '../../../facades/secrets/hooks'
import {
  advanceSecretCapture,
  createSecretCapture,
  protectedReplacement,
  type SecretCapture,
} from './secret-capture'

type PendingEditSecretCapture = {
  capture: SecretCapture
  messageId: string
}

export const useChannelMessageActions = (threadId?: string, projectId?: string | null) => {
  const { mutate: addMessageReaction } = useAddMessageReaction(threadId)
  const { isPending: updatePending, mutateAsync: updateMessage } =
    useUpdateMessage(threadId)
  const { mutate: deleteMessage } = useDeleteMessage(threadId)
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null)
  // The message's stored text: the draft's baseline, so an edit that changes
  // nothing is never persisted and Escape on an untouched row leaves no trace.
  const [editingBaseline, setEditingBaseline] = useState('')
  // Drafts (docs/navigation/overview.md → "Drafts"): an in-progress edit is keyed by the
  // message, so Escape keeps it instead of discarding a person's rewrite.
  const editDraft = useDraft<string>(draftKey('message-edit', editingMessageId), {
    initial: editingBaseline,
    isEmpty: (value) => value === editingBaseline || detectSecrets(value).length > 0,
  })
  const editingContent = editDraft.draft
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null)
  const [pendingSecretEdit, setPendingSecretEdit] =
    useState<PendingEditSecretCapture | null>(null)
  const pendingSecretEditRef = useRef<PendingEditSecretCapture | null>(null)

  const storePendingSecretEdit = useCallback((value: PendingEditSecretCapture | null) => {
    pendingSecretEditRef.current = value
    setPendingSecretEdit(value)
  }, [])

  // The confirm outlives a channel switch: this hook sits at page level while
  // the dialog renders inside a surface that stays mounted. Without this, a
  // confirm opened in one channel and accepted after switching would delete the
  // id from the NEW thread — window.confirm could not go stale that way because
  // it blocked.
  useEffect(() => {
    setPendingDeleteId(null)
    storePendingSecretEdit(null)
  }, [storePendingSecretEdit, threadId])

  const startEdit = useCallback((messageId: string, content: string) => {
    setEditingBaseline(content)
    setEditingMessageId(messageId)
  }, [])

  // Closing the editor is not discarding it: the draft stays under this
  // message's key and the next Edit reopens where the person left off.
  const cancelEdit = useCallback(() => {
    setEditingMessageId(null)
  }, [])

  const submitEdit = useCallback(
    async (messageId: string) => {
      const next = editingContent.trim()
      if (!next) {
        return
      }

      const capture = createSecretCapture({ content: next, projectId })
      if (capture) {
        storePendingSecretEdit({ capture, messageId })
        editDraft.clear()
        setEditingMessageId(null)
        return
      }

      try {
        await updateMessage({ content: next, messageId })
        // Saved: the rewrite is no longer unsent, so its draft goes.
        editDraft.clear()
      } finally {
        setEditingMessageId(null)
      }
    },
    [editDraft, editingContent, projectId, storePendingSecretEdit, updateMessage],
  )

  const confirmSecretEdit = useCallback(async (
    secret: SecretRecord,
    identity: { captureId: string; currentIndex: number },
  ) => {
    const pending = pendingSecretEditRef.current
    if (
      !pending
      || pending.capture.captureId !== identity.captureId
      || pending.capture.currentIndex !== identity.currentIndex
    ) return
    const next = advanceSecretCapture(pending.capture, secret.name)
    if (next) {
      storePendingSecretEdit({ ...pending, capture: next })
      return
    }
    storePendingSecretEdit(null)
    await updateMessage({
      content: protectedReplacement(pending.capture, secret.name),
      messageId: pending.messageId,
    })
  }, [storePendingSecretEdit, updateMessage])

  // Asking is all this does now. `window.confirm` blocked here and returned the
  // answer inline; a themed dialog cannot, so the delete moved to the one place
  // that runs only after a person has said yes — `performDelete`, wired to the
  // dialog's confirm control and referenced nowhere else.
  const confirmDelete = useCallback((messageId: string) => {
    setPendingDeleteId(messageId)
  }, [])

  const cancelDelete = useCallback(() => {
    setPendingDeleteId(null)
  }, [])

  const performDelete = useCallback(() => {
    if (!pendingDeleteId) {
      return
    }
    setPendingDeleteId(null)
    deleteMessage(pendingDeleteId)
  }, [deleteMessage, pendingDeleteId])

  const addReaction = useCallback(
    (messageId: string, emoji: string) => {
      addMessageReaction({ emoji, messageId })
    },
    [addMessageReaction],
  )

  // The hook owns the pending target, so it owns the dialog. Each consumer
  // renders this node beside its message feed; four copies of the same markup
  // at the four call sites would be the fork Rule zero names.
  const deleteConfirm: ReactNode = (
    <ConfirmDialog
      body="This cannot be undone."
      confirmLabel="Delete"
      destructive
      onCancel={cancelDelete}
      onConfirm={performDelete}
      open={pendingDeleteId !== null}
      title="Delete this message?"
    />
  )
  const secretCaptureDialog: ReactNode = pendingSecretEdit ? (
    <SecretCaptureDialog
      capture={pendingSecretEdit.capture}
      key={`${pendingSecretEdit.capture.captureId}:${pendingSecretEdit.capture.currentIndex}`}
      onClose={() => storePendingSecretEdit(null)}
      onSaved={confirmSecretEdit}
    />
  ) : null

  return {
    addReaction,
    cancelEdit,
    changeEditingContent: editDraft.setDraft,
    confirmDelete,
    deleteConfirm,
    secretCaptureDialog,
    editingContent,
    editingMessageId,
    startEdit,
    submitEdit,
    updatePending,
  }
}
