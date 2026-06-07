import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { SetChannelMuteRequest } from '@nessie/schemas'
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
    mutationFn: (input: {
      label: string
      teamId?: string
      visibility?: ChannelRecord['visibility']
    }) =>
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

// sp-channels: channel lifecycle hooks

export const useUpdateChannel = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: {
      channelId: string
      label?: string
      topic?: string | null
      description?: string | null
    }) => {
      const { channelId, ...body } = input
      return apiClient.patch<ChannelRecord>(`/api/channels/${channelId}`, body)
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['channels'] })
    },
  })
}

export const useArchiveChannel = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: { channelId: string; archived: boolean }) =>
      apiClient.post<ChannelRecord>(
        `/api/channels/${input.channelId}/${input.archived ? 'archive' : 'unarchive'}`,
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['channels'] })
    },
  })
}

export const useJoinChannel = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: { channelId: string }) =>
      apiClient.post<ChannelRecord>(`/api/channels/${input.channelId}/join`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['channels'] })
    },
  })
}

export const useSetChannelMute = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation<{ muted: boolean }, Error, SetChannelMuteRequest & { channelId: string }>({
    mutationFn: ({ channelId, muted }) =>
      apiClient.patch<{ muted: boolean }>(`/api/channels/${channelId}/notifications`, {
        muted,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['channels'] })
    },
  })
}
