import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query'

import type { ChannelRecord, ThreadMessageRecord } from '@nessie/client-core'

import { useAuth } from './auth-context'

export const useChannels = (): UseQueryResult<ChannelRecord[]> => {
  const { apiClient, status } = useAuth()
  return useQuery({
    enabled: status === 'signed-in',
    queryKey: ['channels'],
    queryFn: () => apiClient.get<ChannelRecord[]>('/api/channels'),
  })
}

export const useChannel = (channelId: string | undefined): UseQueryResult<ChannelRecord | undefined> => {
  const { apiClient, status } = useAuth()
  return useQuery({
    enabled: status === 'signed-in' && Boolean(channelId),
    queryKey: ['channel', channelId],
    queryFn: async () => {
      const channels = await apiClient.get<ChannelRecord[]>('/api/channels')
      return channels.find((channel) => channel.id === channelId)
    },
  })
}

export const useThreadMessages = (
  threadId: string | undefined,
): UseQueryResult<ThreadMessageRecord[]> => {
  const { apiClient, status } = useAuth()
  return useQuery({
    enabled: status === 'signed-in' && Boolean(threadId),
    queryKey: ['thread-messages', threadId],
    queryFn: () => apiClient.get<ThreadMessageRecord[]>(`/api/threads/${threadId}/messages`),
  })
}

export const useSendMessage = (
  threadId: string | undefined,
): UseMutationResult<ThreadMessageRecord, Error, string> => {
  const { apiClient } = useAuth()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (content: string) =>
      apiClient.post<ThreadMessageRecord>(`/api/threads/${threadId}/messages`, { content }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['thread-messages', threadId] })
    },
  })
}
