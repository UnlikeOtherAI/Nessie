import {
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import type {
  McpCredentialPrincipalType,
  McpServerLifecycleState,
  McpServerScopeType,
} from '@nessie/schemas'
import { useApiClient } from '../../providers/ApiClientProvider'

/**
 * Domain facade for `McpServerInstance` rows (installed servers at a scope).
 * Implements the install / test / credentials-override flows behind the MCP
 * App Store wizard (plan §7).
 */

export type McpServerInstanceRecord = {
  id: string
  catalogEntryId: string
  organizationId: string
  scopeType: McpServerScopeType
  scopeId: string
  credentialRef: string | null
  transportConfig: Record<string, unknown>
  discoveredTools: Array<Record<string, unknown>>
  lifecycleState: McpServerLifecycleState
  healthLastCheckedAt: string | null
  healthFailureCount: number
  installedBy: string
  createdAt: string
  updatedAt: string
}

export type McpCredentialOverrideRecord = {
  id: string
  instanceId: string
  principalType: McpCredentialPrincipalType
  principalId: string
  credentialRef: string
  createdAt: string
  updatedAt: string
}

export type CreateInstanceInput = {
  catalogEntryId: string
  scopeType: McpServerScopeType
  scopeId: string
  credentialRef?: string | null
  transportConfig?: Record<string, unknown>
}

export type UpsertCredentialOverrideInput = {
  instanceId: string
  principalType: McpCredentialPrincipalType
  principalId: string
  credentialRef: string
}

const INSTANCE_QUERY_KEY = ['mcp-instances'] as const

const buildSearch = (filters: {
  scopeType?: McpServerScopeType
  scopeId?: string
}): string => {
  const params = new URLSearchParams()
  if (filters.scopeType) params.set('scopeType', filters.scopeType)
  if (filters.scopeId) params.set('scopeId', filters.scopeId)
  const serialised = params.toString()
  return serialised ? `?${serialised}` : ''
}

export const useMcpInstances = (
  filters: { scopeType?: McpServerScopeType; scopeId?: string } = {},
  options: { enabled?: boolean } = {},
) => {
  const apiClient = useApiClient()
  const search = buildSearch(filters)

  return useQuery<McpServerInstanceRecord[]>({
    queryKey: [...INSTANCE_QUERY_KEY, filters.scopeType ?? null, filters.scopeId ?? null],
    queryFn: () => apiClient.get(`/api/mcp/instances${search}`),
    enabled: options.enabled ?? true,
  })
}

export const useCreateInstance = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: CreateInstanceInput) =>
      apiClient.post<McpServerInstanceRecord>('/api/mcp/instances', input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: INSTANCE_QUERY_KEY })
    },
  })
}

export const useDeleteInstance = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (id: string) => apiClient.delete(`/api/mcp/instances/${id}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: INSTANCE_QUERY_KEY })
    },
  })
}

/**
 * Runs the `tools/list` probe and projects discovered tools into the registry
 * (server flips to `active` on success, `error` on failure). The dedicated
 * mutation lets the UI surface failure messages inline without polling.
 */
export const useTestInstance = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (id: string) =>
      apiClient.post<McpServerInstanceRecord>(
        `/api/mcp/instances/${id}/test`,
        {},
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: INSTANCE_QUERY_KEY })
      void queryClient.invalidateQueries({ queryKey: ['mcp-tools'] })
    },
  })
}

const credentialQueryKey = (instanceId: string) =>
  ['mcp-instances', instanceId, 'credentials'] as const

export const useInstanceCredentials = (instanceId?: string) => {
  const apiClient = useApiClient()

  return useQuery<McpCredentialOverrideRecord[]>({
    queryKey: credentialQueryKey(instanceId ?? ''),
    queryFn: () =>
      apiClient.get(`/api/mcp/instances/${instanceId}/credentials`),
    enabled: Boolean(instanceId),
  })
}

export const useUpsertInstanceCredential = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: UpsertCredentialOverrideInput) =>
      apiClient.put<McpCredentialOverrideRecord>(
        `/api/mcp/instances/${input.instanceId}/credentials`,
        {
          principalType: input.principalType,
          principalId: input.principalId,
          credentialRef: input.credentialRef,
        },
      ),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({
        queryKey: credentialQueryKey(variables.instanceId),
      })
    },
  })
}

export const useDeleteInstanceCredential = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: {
      instanceId: string
      principalType: McpCredentialPrincipalType
      principalId: string
    }) =>
      apiClient.delete(
        `/api/mcp/instances/${input.instanceId}/credentials/${input.principalType}/${input.principalId}`,
      ),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({
        queryKey: credentialQueryKey(variables.instanceId),
      })
    },
  })
}
