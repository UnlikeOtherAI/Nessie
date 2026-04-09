import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { ThreadMessageRecord } from '../../lib/api-client'
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
