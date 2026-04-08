import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { UserRecord } from '../../lib/api-client'
import { useApiClient } from '../../providers/ApiClientProvider'

export const useUsers = (enabled = true) => {
  const apiClient = useApiClient()

  return useQuery<UserRecord[]>({
    enabled,
    queryKey: ['users'],
    queryFn: () => apiClient.get('/api/users'),
  })
}

export const useCreateUser = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: {
      channelIds?: string[]
      displayName: string
      email: string
      password: string
      role?: string
    }) => apiClient.post<UserRecord>('/api/users', input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['users'] })
    },
  })
}
