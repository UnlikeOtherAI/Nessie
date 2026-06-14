import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { MeResponse, UserPreferences } from '@nessie/schemas'
import type { AuthProviderDescriptor } from '../../lib/api-client'
import { useApiClient } from '../../providers/ApiClientProvider'
import { useAuthSession } from '../../providers/AuthSessionProvider'

export type SessionSummary = {
  sessionId: string
  userAgent: string | null
  createdAt: string
  lastUsedAt: string
  expiresAt: string
  current: boolean
}

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

// The signed-in user's active sessions (one per device/login), with the current
// one flagged so the UI can label it and avoid surprising self-logout.
export const useSessions = () => {
  const apiClient = useApiClient()

  return useQuery<SessionSummary[]>({
    queryKey: ['auth', 'sessions'],
    queryFn: () => apiClient.get('/api/auth/sessions'),
  })
}

export const useRevokeSession = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (sessionId: string) =>
      apiClient.delete<{ revoked: number }>(`/api/auth/sessions/${sessionId}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['auth', 'sessions'] })
    },
  })
}

export const useChangePassword = () => {
  const apiClient = useApiClient()

  return useMutation<{ ok: boolean }, Error, { currentPassword: string; newPassword: string }>({
    mutationFn: (input) => apiClient.post('/api/auth/password', input),
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
