import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { PresenceListResponse, PresenceManualState } from '../../lib/api-client'
import { useApiClient } from '../../providers/ApiClientProvider'

export const presenceKeys = {
  all: ['presence'] as const,
}

// Org-wide presence + active-status map. Polled so every avatar can badge other
// users; the current user's own dot is refined locally in PresenceProvider.
export const usePresenceList = (enabled: boolean) => {
  const apiClient = useApiClient()

  return useQuery<PresenceListResponse>({
    queryKey: presenceKeys.all,
    queryFn: () => apiClient.get('/api/presence'),
    enabled,
    refetchInterval: 20_000,
    refetchOnWindowFocus: true,
  })
}

export const useSetManualPresence = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (state: PresenceManualState | null) =>
      apiClient.put('/api/presence/me', { state }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: presenceKeys.all })
    },
  })
}
