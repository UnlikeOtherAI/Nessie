import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { CallRecord } from '../../lib/api-client'
import { callKeys } from '../../lib/query-keys'
import { useApiClient } from '../../providers/ApiClientProvider'

export const useActiveCall = (channelId: string | undefined) => {
  const apiClient = useApiClient()

  return useQuery<CallRecord | null>({
    queryKey: callKeys.forChannel(channelId),
    queryFn: async () => {
      try {
        return await apiClient.get<CallRecord | null>(
          `/api/channels/${channelId}/call`,
        )
      } catch {
        return null
      }
    },
    enabled: !!channelId,
    staleTime: 10_000,
    refetchInterval: (query) => (query.state.data ? 5_000 : 30_000),
  })
}

export const useStartCall = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (channelId: string) =>
      apiClient.post<CallRecord>(`/api/channels/${channelId}/call`),
    onSuccess: (data, channelId) => {
      queryClient.setQueryData(callKeys.forChannel(channelId), data)
      void queryClient.invalidateQueries({ queryKey: callKeys.forChannel(channelId) })
    },
  })
}

export const useEndCall = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (channelId: string) =>
      apiClient.delete<CallRecord>(`/api/channels/${channelId}/call`),
    onSuccess: (_data, channelId) => {
      void queryClient.invalidateQueries({ queryKey: callKeys.forChannel(channelId) })
    },
  })
}
