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
import { mcpKeys } from '../../lib/query-keys'
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
  transportConfig: Record<string, unknown>
  discoveredTools: Array<Record<string, unknown>>
  lifecycleState: McpServerLifecycleState
  healthLastCheckedAt: string | null
  healthFailureCount: number
  /**
   * Tools this instance projected that no owner has reviewed yet. Drives the
   * "N tools awaiting review" doorway on the Connectors page — a connector
   * with a non-zero count is installed but inert, because the worker only
   * exposes `active` tools.
   */
  pendingToolCount: number
  installedBy: string
  createdAt: string
  updatedAt: string
}

export type McpCredentialOverrideRecord = {
  id: string
  instanceId: string
  principalType: McpCredentialPrincipalType
  principalId: string
  createdAt: string
  updatedAt: string
}

export type CreateInstanceInput = {
  catalogEntryId: string
  scopeType: McpServerScopeType
  scopeId: string
  transportConfig?: Record<string, unknown>
}

export type UpsertCredentialOverrideInput = {
  instanceId: string
  principalType: McpCredentialPrincipalType
  principalId: string
  secret: string
}

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
    queryKey: mcpKeys.instanceList(filters.scopeType ?? null, filters.scopeId ?? null),
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
      void queryClient.invalidateQueries({ queryKey: mcpKeys.instances })
    },
  })
}

export const useDeleteInstance = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (id: string) => apiClient.delete(`/api/mcp/instances/${id}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: mcpKeys.instances })
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
      void queryClient.invalidateQueries({ queryKey: mcpKeys.instances })
      void queryClient.invalidateQueries({ queryKey: mcpKeys.tools })
    },
  })
}

export const useInstanceCredentials = (instanceId?: string) => {
  const apiClient = useApiClient()

  return useQuery<McpCredentialOverrideRecord[]>({
    queryKey: mcpKeys.instanceCredentials(instanceId ?? ''),
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
          secret: input.secret,
        },
      ),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({
        queryKey: mcpKeys.instanceCredentials(variables.instanceId),
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
        queryKey: mcpKeys.instanceCredentials(variables.instanceId),
      })
    },
  })
}
