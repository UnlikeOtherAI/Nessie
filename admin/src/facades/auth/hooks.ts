import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query'
import { useEffect } from 'react'
import type { MeResponse, SessionSummary, UserPreferences } from '@nessie/schemas'
import type { AuthProviderDescriptor } from '../../lib/api-client'
import { uploadMyUoaAvatar } from '../../lib/uploads'
import { authKeys } from './keys'
import { useApiClient } from '../../providers/ApiClientProvider'
import { useAuthSession } from '../../providers/AuthSessionProvider'

const bumpMyAvatarRevision = (queryClient: QueryClient): void => {
  queryClient.setQueryData<number>(
    authKeys.myAvatarRevision,
    (current) => (current ?? 0) + 1,
  )
}

export type { SessionSummary } from '@nessie/schemas'

/**
 * The derivation itself, over a session that may not exist yet. A signed-out
 * session is not an owner — the `?? false` every call site carried.
 *
 * `roleIds` is dereferenced without a second `?.`, matching 25 of the 29
 * call sites this replaces. Four disagreed (`roleIds?.includes`), and that
 * chain was unreachable defence rather than a guard someone needs back: all
 * four render inside `AdminShellLayout`, whose `useAdminShell` reads
 * `me?.user.roleIds.includes('owner')` *unguarded* on the same object before
 * any of them mounts. A session that could reach them with no `roleIds` has
 * already crashed one level up. Nothing feeds a partial session either — the
 * provider persists only the bearer token and re-fetches `me` from
 * `/api/auth/me` on every mount, and the debug-session import deliberately
 * discards the pasted user and re-fetches too. The field is required by
 * `MeUserSchema` and set unconditionally by `buildMeResponse`.
 */
export const isOwnerSession = (me: MeResponse | null): boolean =>
  me?.user.roleIds.includes('owner') ?? false

/** The same question, asked from a component or a hook. */
export const useIsOwner = (): boolean => isOwnerSession(useAuthSession().me)

export const useAuthProviders = () => {
  const apiClient = useApiClient()

  return useQuery<AuthProviderDescriptor[]>({
    queryKey: authKeys.providers,
    queryFn: () => apiClient.get('/api/auth/providers'),
    staleTime: 60_000,
  })
}

/**
 * The signed-in session, re-read on a cadence the query cache owns.
 *
 * Focus mode and the starred list are preferences a person changes on another
 * device, so the session has to notice. This used to be a `setInterval` plus a
 * `focus`/`visibilitychange` pair inside `FocusModeProvider`, with a hand-rolled
 * request-version counter to stop a late response overwriting a local change.
 * React Query already owns all three: one query deduped across every caller,
 * paused while the tab is hidden (`refetchIntervalInBackground` is false by
 * default), refetched on focus, and cancellable by the preference mutation
 * below. The provider bails on a structurally identical response, so an
 * unchanged poll re-renders none of the ~115 `useAuthSession()` readers.
 */
export const useSessionMe = () => {
  const apiClient = useApiClient()
  const { applyMeResponse, me } = useAuthSession()

  const query = useQuery<MeResponse>({
    queryKey: authKeys.me,
    queryFn: () => apiClient.get<MeResponse>('/api/auth/me'),
    enabled: Boolean(me),
    // The session provider has already read `/me` to get here, so seeding the
    // entry with it — fresh for one interval — keeps this from firing a second
    // identical request on the mount that follows sign-in. It also bounds the
    // focus refetch: a burst of tab switches inside the window costs nothing.
    initialData: me ?? undefined,
    refetchInterval: 15_000,
    refetchOnWindowFocus: true,
    staleTime: 15_000,
  })

  const { data } = query
  useEffect(() => {
    if (data) applyMeResponse(data)
  }, [applyMeResponse, data])

  return query
}

export const useUpdatePreferences = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()
  const { applyMeResponse } = useAuthSession()

  return useMutation<MeResponse, Error, UserPreferences>({
    mutationFn: (preferences) =>
      apiClient.patch<MeResponse>('/api/auth/me/preferences', preferences),
    // A `/me` read that started before this write must not land after it and
    // republish the preference the person just changed. Cancelling it is what
    // the provider's bespoke request-version counter used to do by hand.
    onMutate: () => queryClient.cancelQueries({ queryKey: authKeys.me }),
    onSuccess: (me) => {
      // The echo is newer than anything the poll holds, so it seeds the entry
      // rather than waiting to be overwritten by the next interval.
      queryClient.setQueryData(authKeys.me, me)
      applyMeResponse(me)
    },
  })
}

// The signed-in user's active sessions (one per device/login), with the current
// one flagged so the UI can label it and avoid surprising self-logout.
export const useSessions = () => {
  const apiClient = useApiClient()

  return useQuery<SessionSummary[]>({
    queryKey: authKeys.sessions,
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
      void queryClient.invalidateQueries({ queryKey: authKeys.sessions })
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
 * by a successful change — the same pattern as the team avatar. Deliberately
 * client-only: nothing fetches it, so it never refetches or resets on its own.
 */
export const useMyAvatarRevision = (): number => {
  const { data } = useQuery({
    queryKey: authKeys.myAvatarRevision,
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
