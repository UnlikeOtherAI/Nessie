import { useQuery } from '@tanstack/react-query'

import type {
  UnreadDirectMessageRecord,
  UnreadDirectMessagesResponse,
} from '../../lib/api-client'
import { threadKeys } from './keys'
import { useApiClient } from '../../providers/ApiClientProvider'

export const useUnreadDirectMessages = () => {
  const apiClient = useApiClient()

  return useQuery<UnreadDirectMessageRecord[]>({
    queryKey: threadKeys.unreadDirectMessages,
    queryFn: async () => {
      const response = await apiClient.get<UnreadDirectMessagesResponse>(
        '/api/direct-messages/unread',
      )
      return response.items
    },
    // SSE refreshes the active query immediately; this interval reconciles a
    // changed membership or a missed frame without a second persistent socket.
    refetchInterval: 15_000,
  })
}
