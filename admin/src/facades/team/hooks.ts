import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { teamKeys } from './keys'
import { useApiClient } from '../../providers/ApiClientProvider'
import { uploadTeamAvatar } from '../../lib/uploads'
import { useAuthSession } from '../../providers/AuthSessionProvider'

/**
 * The team avatar lives behind one fixed URL (`/api/team/avatar`) and
 * is cached by the browser for five minutes, so a fresh upload would keep
 * showing the old image everywhere it is rendered. This counter is the shared
 * cache-buster: the settings panel and the sidebar both read it, and a
 * successful mutation bumps it. It is deliberately client-only — its queryFn
 * returns a constant, so any refetch RESETS it. Because the key nests under
 * `teamKeys.all` (the key-family invariant requires it) and the shell's
 * TeamSwitcher keeps the query always active, a non-exact invalidation of
 * that root refetches it and silently returns the counter to 0 — every
 * team-directory invalidation is therefore `exact: true`.
 */
export const teamAvatarRevisionQueryOptions = () => ({
  queryKey: teamKeys.avatarRevision,
  queryFn: () => 0,
  initialData: 0,
  gcTime: Infinity,
  staleTime: Infinity,
})

export const useTeamAvatarRevision = (): number => {
  const { data } = useQuery(teamAvatarRevisionQueryOptions())
  return data
}

const bumpAvatarRevision = (queryClient: QueryClient): void => {
  queryClient.setQueryData<number>(
    teamKeys.avatarRevision,
    (current) => (current ?? 0) + 1,
  )
}

/** Owners/admins replace the team's UnlikeOtherAI company avatar. */
export const useUploadTeamAvatar = () => {
  const { token } = useAuthSession()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (file: File) => uploadTeamAvatar(file, token),
    onSuccess: () => bumpAvatarRevision(queryClient),
  })
}

/** Owners/admins clear it; UOA falls back to the team icon or a generated image. */
export const useRemoveTeamAvatar = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: () => apiClient.delete<{ ok: boolean }>('/api/team/avatar'),
    onSuccess: () => bumpAvatarRevision(queryClient),
  })
}
