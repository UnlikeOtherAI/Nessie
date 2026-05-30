import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { MessageSearchResult, ThreadMessageRecord } from '../../lib/api-client'
import { useApiClient } from '../../providers/ApiClientProvider'

export const useSendMessage = (threadId?: string) => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: { content: string }) =>
      apiClient.post<ThreadMessageRecord>(`/api/threads/${threadId}/messages`, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['threads', threadId, 'messages'] })
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
