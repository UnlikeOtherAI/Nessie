import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  CommsConnectionDetail,
  CommsConnectionListResponse,
  CommsConnectionStartResponse,
  CommsProvider,
  CommsResourceToggle,
  GoogleCapabilityId,
} from '../../lib/api-client'
import { commsKeys } from '../../lib/query-keys'
import { useApiClient } from '../../providers/ApiClientProvider'

/**
 * React-Query facade for the Individual Communications Connector "Connected
 * accounts" surface. Every call is scoped server-side to the session user, so
 * the client never passes an owner id. The response envelope is unwrapped by
 * the shared api-client, so hooks receive plain data.
 */
export const useCommsConnections = () => {
  const apiClient = useApiClient()
  return useQuery<CommsConnectionListResponse>({
    queryKey: commsKeys.connections,
    queryFn: () => apiClient.get('/api/comms/connections'),
  })
}

export const useCommsConnection = (id: string | null) => {
  const apiClient = useApiClient()
  return useQuery<CommsConnectionDetail>({
    placeholderData: keepPreviousData,
    queryKey: commsKeys.connection(id ?? 'none'),
    queryFn: () => apiClient.get(`/api/comms/connections/${id}`),
    enabled: id !== null,
  })
}

/**
 * Begin an OAuth connect. Returns the provider authorize URL; the caller opens
 * it in a new tab. Never invalidates — the connection appears after the OAuth
 * callback redirects the user back.
 */
export type StartCommsConnectionInput = {
  provider: CommsProvider
  /** Google capability ids to request. Omitted → the provider default set. */
  capabilities?: GoogleCapabilityId[]
  /**
   * Widen this existing connection instead of creating one. The server asks
   * Google for the union of its current scopes and the new ones.
   */
  connectionId?: string
}

export const useStartCommsConnection = () => {
  const apiClient = useApiClient()
  return useMutation({
    mutationFn: (input: StartCommsConnectionInput | CommsProvider) => {
      const normalized: StartCommsConnectionInput =
        typeof input === 'string' ? { provider: input } : input
      const body: Record<string, unknown> = {}
      if (normalized.capabilities) body.capabilities = normalized.capabilities
      if (normalized.connectionId) body.connectionId = normalized.connectionId
      return apiClient.post<CommsConnectionStartResponse>(
        `/api/comms/connections/${normalized.provider}/start`,
        body,
      )
    },
  })
}

/**
 * Switch capabilities off locally. This is not a revocation at Google — a
 * provider grant can only be revoked whole — so the copy says "blocked" and
 * the server enforces it when a tool asks for a credential.
 */
export const useUpdateCommsCapabilities = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: { id: string; disabledCapabilities: GoogleCapabilityId[] }) =>
      apiClient.patch<CommsConnectionDetail>(
        `/api/comms/connections/${input.id}/capabilities`,
        { disabledCapabilities: input.disabledCapabilities },
      ),
    onSuccess: (_data, input) => {
      void queryClient.invalidateQueries({ queryKey: commsKeys.connection(input.id) })
      void queryClient.invalidateQueries({ queryKey: commsKeys.connections })
    },
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
      void queryClient.invalidateQueries({ queryKey: commsKeys.connection(input.id) })
      void queryClient.invalidateQueries({ queryKey: commsKeys.connections })
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
      void queryClient.invalidateQueries({ queryKey: commsKeys.connection(id) })
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
      void queryClient.invalidateQueries({ queryKey: commsKeys.connections })
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
      void queryClient.invalidateQueries({ queryKey: commsKeys.connection(id) })
      void queryClient.invalidateQueries({ queryKey: commsKeys.connections })
    },
  })
}
