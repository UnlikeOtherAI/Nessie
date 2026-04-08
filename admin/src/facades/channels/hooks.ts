import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ChannelRecord } from '../../lib/api-client'
import { useApiClient } from '../../providers/ApiClientProvider'

export const useChannels = () => {
  const apiClient = useApiClient()

  return useQuery<ChannelRecord[]>({
    queryKey: ['channels'],
    queryFn: () => apiClient.get('/api/channels'),
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
