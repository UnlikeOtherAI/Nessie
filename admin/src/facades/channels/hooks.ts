import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ChannelRecord } from '../../lib/api-client'
import { useApiClient } from '../../providers/ApiClientProvider'

export const useChannels = () => {
  const apiClient = useApiClient()

  return useQuery<ChannelRecord[]>({
    queryKey: ['channels'],
    queryFn: () => apiClient.get('/api/channels'),
    staleTime: Infinity,
  })
}

export const useOpenDm = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (userId: string) =>
      apiClient.post<ChannelRecord>(`/api/dm/${userId}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['channels'] })
      void queryClient.invalidateQueries({ queryKey: ['users'] })
    },
  })
}

export const useCreateChannel = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: { label: string; visibility?: ChannelRecord['visibility'] }) =>
      apiClient.post<ChannelRecord>('/api/channels', input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['channels'] })
    },
  })
}

export const useAddChannelMember = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: { channelId: string; userId: string }) =>
      apiClient.post<ChannelRecord | undefined>(`/api/channels/${input.channelId}/members`, {
        userId: input.userId,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['users'] })
      void queryClient.invalidateQueries({ queryKey: ['channels'] })
    },
  })
}

export const useRemoveChannelMember = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: { channelId: string; userId: string }) =>
      apiClient.delete(
        `/api/channels/${input.channelId}/members/${input.userId}`,
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['users'] })
      void queryClient.invalidateQueries({ queryKey: ['channels'] })
    },
  })
}
