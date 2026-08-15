import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query'
import type { MeResponse, UserPreferences } from '@nessie/schemas'
import type { AuthProviderDescriptor } from '../../lib/api-client'
import { uploadMyUoaAvatar } from '../../lib/uploads'
import { useApiClient } from '../../providers/ApiClientProvider'
import { useAuthSession } from '../../providers/AuthSessionProvider'

const myAvatarRevisionKey = ['auth', 'me', 'avatar', 'revision'] as const

const bumpMyAvatarRevision = (queryClient: QueryClient): void => {
  queryClient.setQueryData<number>(
    myAvatarRevisionKey,
    (current) => (current ?? 0) + 1,
  )
}

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

// Set (attachment id) or clear (null) the signed-in user's local avatar. Only
// reachable in deployments with no UOA — a UOA session's profile photo belongs
// to UOA and the API refuses this route with PROFILE_MANAGED_BY_SSO.
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

/**
 * The UOA-hosted profile photo lives behind one fixed relay URL, so a fresh
 * upload would keep showing the old image everywhere it is rendered. This is
 * the shared cache-buster the profile panel and the account button read, bumped
 * by a successful change — the same pattern as the workspace avatar. Deliberately
 * client-only: nothing fetches it, so it never refetches or resets on its own.
 */
export const useMyAvatarRevision = (): number => {
  const { data } = useQuery({
    queryKey: myAvatarRevisionKey,
    queryFn: () => 0,
    initialData: 0,
    gcTime: Infinity,
    staleTime: Infinity,
  })
  return data
}

/** Replace the signed-in person's photo at UnlikeOtherAI, which owns it. */
export const useUploadMyUoaAvatar = () => {
  const { token } = useAuthSession()
  const queryClient = useQueryClient()

  return useMutation<void, Error, File>({
    mutationFn: (file) => uploadMyUoaAvatar(file, token),
    onSuccess: () => bumpMyAvatarRevision(queryClient),
  })
}

/** Clear it; UOA falls back to its provider proxy or generated image. */
export const useRemoveMyUoaAvatar = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation<{ ok: boolean }, Error, void>({
    mutationFn: () => apiClient.delete<{ ok: boolean }>('/api/auth/me/avatar/uoa'),
    onSuccess: () => bumpMyAvatarRevision(queryClient),
  })
}
