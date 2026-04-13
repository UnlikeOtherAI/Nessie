import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { CallRecord } from '../../lib/api-client'
import { useApiClient } from '../../providers/ApiClientProvider'

export const useActiveCall = (channelId: string | undefined) => {
  const apiClient = useApiClient()

  return useQuery<CallRecord | null>({
    queryKey: ['call', channelId],
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
    refetchInterval: 5000,
  })
}

export const useStartCall = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (channelId: string) =>
      apiClient.post<CallRecord>(`/api/channels/${channelId}/call`),
    onSuccess: (_data, channelId) => {
      void queryClient.invalidateQueries({ queryKey: ['call', channelId] })
    },
  })
}

export const useJoinCall = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (callId: string) =>
      apiClient.post<CallRecord>(`/api/calls/${callId}/join`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['call'] })
    },
  })
}

export const useLeaveCall = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (callId: string) =>
      apiClient.post<CallRecord>(`/api/calls/${callId}/leave`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['call'] })
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
      void queryClient.invalidateQueries({ queryKey: ['call', channelId] })
    },
  })
}
