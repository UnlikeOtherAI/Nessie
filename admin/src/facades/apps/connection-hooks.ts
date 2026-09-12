import { useMutation, useQueryClient } from '@tanstack/react-query'

import { useApiClient } from '../../providers/ApiClientProvider'
import { APPS_QUERY_KEY } from './hooks'

/** Remove one connection and refresh every list/detail that can name it. */
export const useDisconnectAppConnection = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (connectionId: string) =>
      apiClient.delete(`/api/app-connections/${encodeURIComponent(connectionId)}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: APPS_QUERY_KEY })
    },
  })
}

/** Start the existing account's sign-in again; this never creates another row. */
export const useReconnectAppConnection = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (connectionId: string) =>
      apiClient.post<unknown>(`/api/app-connections/${encodeURIComponent(connectionId)}/reconnect`, {}),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: APPS_QUERY_KEY })
    },
  })
}

export type AppCapabilitiesRefreshResult = {
  connectionId: string
  status: 'connected' | 'connecting' | 'disabled' | 'error' | 'expired'
  toolCount: number
}

/** Re-probe one account and then read the catalogue's refreshed capability projection. */
export const useRefreshAppConnectionCapabilities = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (connectionId: string) =>
      apiClient.post<AppCapabilitiesRefreshResult>(
        `/api/app-connections/${encodeURIComponent(connectionId)}/refresh-capabilities`,
        {},
      ),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: APPS_QUERY_KEY })
    },
  })
}

/**
 * The detail hero removes an app by disconnecting every account it currently
 * exposes. Each request keeps the server's per-scope authorization boundary:
 * a client-side list can never remove an account the existing DELETE route
 * would reject.
 */
export const useRemoveAppConnections = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (connectionIds: readonly string[]) => {
      const results = await Promise.allSettled(
        connectionIds.map((connectionId) =>
          apiClient.delete(`/api/app-connections/${encodeURIComponent(connectionId)}`),
        ),
      )
      if (results.some((result) => result.status === 'rejected')) {
        throw new Error('One or more connected accounts could not be removed')
      }
    },
    onSettled: () => {
      // A concurrent change can reject one account after another has already
      // been removed. Wait for every request before re-reading the app, rather
      // than paint stale rows while sibling deletes are still in flight.
      void queryClient.invalidateQueries({ queryKey: APPS_QUERY_KEY })
    },
  })
}
