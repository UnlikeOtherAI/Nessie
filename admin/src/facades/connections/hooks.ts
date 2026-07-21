import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  CommsConnectionDetail,
  CommsConnectionListResponse,
  CommsConnectionStartResponse,
  CommsProvider,
  CommsResourceToggle,
} from '../../lib/api-client'
import { useApiClient } from '../../providers/ApiClientProvider'

/**
 * React-Query facade for the Individual Communications Connector "Connected
 * accounts" surface. Every call is scoped server-side to the session user, so
 * the client never passes an owner id. The response envelope is unwrapped by
 * the shared api-client, so hooks receive plain data.
 */
export const commsConnectionsKey = ['comms', 'connections'] as const
export const commsConnectionKey = (id: string) =>
  ['comms', 'connections', id] as const

export const useCommsConnections = () => {
  const apiClient = useApiClient()
  return useQuery<CommsConnectionListResponse>({
    queryKey: commsConnectionsKey,
    queryFn: () => apiClient.get('/api/comms/connections'),
  })
}

export const useCommsConnection = (id: string | null) => {
  const apiClient = useApiClient()
  return useQuery<CommsConnectionDetail>({
    queryKey: id ? commsConnectionKey(id) : ['comms', 'connections', 'none'],
    queryFn: () => apiClient.get(`/api/comms/connections/${id}`),
    enabled: id !== null,
  })
}

/**
 * Begin an OAuth connect. Returns the provider authorize URL; the caller opens
 * it in a new tab. Never invalidates — the connection appears after the OAuth
 * callback redirects the user back.
 */
export const useStartCommsConnection = () => {
  const apiClient = useApiClient()
  return useMutation({
    mutationFn: (provider: CommsProvider) =>
      apiClient.post<CommsConnectionStartResponse>(
        `/api/comms/connections/${provider}/start`,
      ),
  })
}

export const useUpdateCommsResources = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: { id: string; resources: CommsResourceToggle[] }) =>
      apiClient.patch<CommsConnectionDetail>(
        `/api/comms/connections/${input.id}/resources`,
        { resources: input.resources },
      ),
    onSuccess: (_data, input) => {
      void queryClient.invalidateQueries({ queryKey: commsConnectionKey(input.id) })
      void queryClient.invalidateQueries({ queryKey: commsConnectionsKey })
    },
  })
}

export const useResyncCommsConnection = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) =>
      apiClient.post<{ queued: boolean }>(`/api/comms/connections/${id}/resync`),
    onSuccess: (_data, id) => {
      void queryClient.invalidateQueries({ queryKey: commsConnectionKey(id) })
    },
  })
}

export const useDisconnectCommsConnection = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) =>
      apiClient.delete<void>(`/api/comms/connections/${id}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: commsConnectionsKey })
    },
  })
}

export const useDeleteCommsData = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) =>
      apiClient.delete<void>(`/api/comms/connections/${id}/data`),
    onSuccess: (_data, id) => {
      void queryClient.invalidateQueries({ queryKey: commsConnectionKey(id) })
      void queryClient.invalidateQueries({ queryKey: commsConnectionsKey })
    },
  })
}
