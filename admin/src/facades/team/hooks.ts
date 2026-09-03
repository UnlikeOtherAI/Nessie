import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { teamKeys } from '../../lib/query-keys'
import { useApiClient } from '../../providers/ApiClientProvider'
import { uploadTeamAvatar } from '../../lib/uploads'
import { useAuthSession } from '../../providers/AuthSessionProvider'

/**
 * The team avatar lives behind one fixed URL (`/api/team/avatar`) and
 * is cached by the browser for five minutes, so a fresh upload would keep
 * showing the old image everywhere it is rendered. This counter is the shared
 * cache-buster: the settings panel and the sidebar both read it, and a
 * successful mutation bumps it. It is deliberately client-only — nothing fetches
 * it — so it never refetches or resets on its own.
 */
export const useTeamAvatarRevision = (): number => {
  const { data } = useQuery({
    queryKey: teamKeys.avatarRevision,
    queryFn: () => 0,
    initialData: 0,
    gcTime: Infinity,
    staleTime: Infinity,
  })
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
