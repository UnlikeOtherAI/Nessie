import { useCallback, useState } from 'react'
import {
  useAddMessageReaction,
  useDeleteMessage,
  useUpdateMessage,
} from '../../../facades/messages/hooks'

export const useChannelMessageActions = (threadId?: string) => {
  const { mutate: addMessageReaction } = useAddMessageReaction(threadId)
  const { isPending: updatePending, mutateAsync: updateMessage } =
    useUpdateMessage(threadId)
  const { mutate: deleteMessage } = useDeleteMessage(threadId)
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null)
  const [editingContent, setEditingContent] = useState('')

  const startEdit = useCallback((messageId: string, content: string) => {
    setEditingMessageId(messageId)
    setEditingContent(content)
  }, [])

  const cancelEdit = useCallback(() => {
    setEditingMessageId(null)
    setEditingContent('')
  }, [])

  const submitEdit = useCallback(
    async (messageId: string) => {
      const next = editingContent.trim()
      if (!next) {
        return
      }

      try {
        await updateMessage({ content: next, messageId })
      } finally {
        cancelEdit()
      }
    },
    [cancelEdit, editingContent, updateMessage],
  )

  const confirmDelete = useCallback(
    (messageId: string) => {
      if (!window.confirm('Delete this message? This cannot be undone.')) {
        return
      }
      deleteMessage(messageId)
    },
    [deleteMessage],
  )

  const addReaction = useCallback(
    (messageId: string, emoji: string) => {
      addMessageReaction({ emoji, messageId })
    },
    [addMessageReaction],
  )

  return {
    addReaction,
    cancelEdit,
    changeEditingContent: setEditingContent,
    confirmDelete,
    editingContent,
    editingMessageId,
    startEdit,
    submitEdit,
    updatePending,
  }
}
