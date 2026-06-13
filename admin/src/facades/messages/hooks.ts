import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { MessageSearchResult, ThreadMessageRecord } from '../../lib/api-client'
import { uploadAttachment, type AttachmentRecord } from '../../lib/uploads'
import { useApiClient } from '../../providers/ApiClientProvider'
import { useAuthSession } from '../../providers/AuthSessionProvider'

export const useSendMessage = (threadId?: string) => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: { content: string; attachmentIds?: string[] }) =>
      apiClient.post<ThreadMessageRecord>(`/api/threads/${threadId}/messages`, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['threads', threadId, 'messages'] })
    },
  })
}

export const useSendMessageToThread = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: { attachmentIds?: string[]; content: string; threadId: string }) =>
      apiClient.post<ThreadMessageRecord>(`/api/threads/${input.threadId}/messages`, {
        attachmentIds: input.attachmentIds,
        content: input.content,
      }),
    onSuccess: (_message, input) => {
      void queryClient.invalidateQueries({
        queryKey: ['threads', input.threadId, 'messages'],
      })
      void queryClient.invalidateQueries({ queryKey: ['channels'] })
    },
  })
}

// sp-messaging slice: edit, delete, and full-text search.
export const useUpdateMessage = (threadId?: string) => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: { messageId: string; content: string }) =>
      apiClient.patch<ThreadMessageRecord>(
        `/api/threads/${threadId}/messages/${input.messageId}`,
        { content: input.content },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['threads', threadId, 'messages'] })
    },
  })
}

export const useDeleteMessage = (threadId?: string) => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (messageId: string) =>
      apiClient.delete<ThreadMessageRecord>(
        `/api/threads/${threadId}/messages/${messageId}`,
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['threads', threadId, 'messages'] })
    },
  })
}

export const useAddMessageReaction = (threadId?: string) => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: { emoji: string; messageId: string }) =>
      apiClient.post<{ ok: boolean }>(
        `/api/threads/${threadId}/messages/${input.messageId}/reactions`,
        { emoji: input.emoji },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['threads', threadId, 'messages'] })
    },
  })
}

export const useMessageSearch = (channelId: string | undefined, query: string) => {
  const apiClient = useApiClient()
  const trimmed = query.trim()

  return useQuery<MessageSearchResult[]>({
    queryKey: ['channels', channelId, 'messages', 'search', trimmed],
    queryFn: () =>
      apiClient.get(
        `/api/channels/${channelId}/messages/search?query=${encodeURIComponent(trimmed)}`,
      ),
    enabled: Boolean(channelId) && trimmed.length > 0,
  })
}

// Upload a file (multipart) and return the created attachment record. Uses the
// raw fetch helper because the JSON ApiClient cannot send FormData bodies.
export const useUploadAttachment = () => {
  const { token } = useAuthSession()
  return useMutation({
    mutationFn: (file: File): Promise<AttachmentRecord> => uploadAttachment(file, token),
  })
}
