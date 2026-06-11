import { useMutation, useQuery } from '@tanstack/react-query'
import type { MeResponse, UserPreferences } from '@nessie/schemas'
import type { AuthProviderDescriptor } from '../../lib/api-client'
import { useApiClient } from '../../providers/ApiClientProvider'
import { useAuthSession } from '../../providers/AuthSessionProvider'

export const useAuthProviders = () => {
  const apiClient = useApiClient()

  return useQuery<AuthProviderDescriptor[]>({
    queryKey: ['auth', 'providers'],
    queryFn: () => apiClient.get('/api/auth/providers'),
    staleTime: 60_000,
  })
}

export const useUpdatePreferences = () => {
  const apiClient = useApiClient()
  const { applyMeResponse } = useAuthSession()

  return useMutation<MeResponse, Error, UserPreferences>({
    mutationFn: (preferences) =>
      apiClient.patch<MeResponse>('/api/auth/me/preferences', preferences),
    onSuccess: (me) => {
      applyMeResponse(me)
    },
  })
}

// Set (attachment id) or clear (null) the signed-in user's custom avatar.
export const useUpdateMyAvatar = () => {
  const apiClient = useApiClient()
  const { applyMeResponse } = useAuthSession()

  return useMutation<MeResponse, Error, string | null>({
    mutationFn: (avatarAttachmentId) =>
      apiClient.patch<MeResponse>('/api/auth/me/avatar', { avatarAttachmentId }),
    onSuccess: (me) => {
      applyMeResponse(me)
    },
  })
}
