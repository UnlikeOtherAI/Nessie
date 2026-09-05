import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { UserRecord } from '../../lib/api-client'
import { userKeys } from './keys'
import { useApiClient } from '../../providers/ApiClientProvider'

export const useUsers = (enabled = true) => {
  const apiClient = useApiClient()

  return useQuery<UserRecord[]>({
    enabled,
    queryKey: userKeys.all,
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
      void queryClient.invalidateQueries({ queryKey: userKeys.all })
    },
  })
}

export const useUpdateUserRole = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: { userId: string; role: string }) =>
      apiClient.patch<UserRecord>(`/api/users/${input.userId}`, { role: input.role }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: userKeys.all })
    },
  })
}

export const useSetUserDeactivated = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: { userId: string; deactivated: boolean }) =>
      apiClient.post<UserRecord>(
        `/api/users/${input.userId}/${input.deactivated ? 'deactivate' : 'reactivate'}`,
        {},
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: userKeys.all })
    },
  })
}
