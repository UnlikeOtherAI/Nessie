import {
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import type {
  ToolGrantSource,
  ToolGrantState,
  ToolRegistryEntryStatus,
  ToolRegistrySource,
  ToolRegistryTransport,
} from '@nessie/schemas'
import { useApiClient } from '../../providers/ApiClientProvider'

/**
 * Domain facade for the tool registry surface (`/api/mcp/tools`) and its grant
 * CRUD. This backs the canonical `/agents/tools` page (filters + detail +
 * per-agent grant matrix). The list response joins each tool's existing grants
 * so the matrix can render and revoke them on first paint. The legacy
 * `useTools()` facade in `facades/tools/hooks.ts` still backs the builtin-only
 * descriptor view used by the agent designer, channel composer, and workflow
 * designer.
 */

export type McpToolRegistryRecord = {
  id: string
  organizationId: string | null
  scopeKey: string
  toolId: string
  label: string
  description: string
  source: ToolRegistrySource
  transport: ToolRegistryTransport
  transportConfig: Record<string, unknown>
  bundleId: string | null
  mcpInstanceId: string | null
  inputSchema: Record<string, unknown>
  outputSchema: Record<string, unknown> | null
  tags: string[]
  status: ToolRegistryEntryStatus
  version: string
  createdBy: string
  enabled: boolean
  builtin: boolean
  createdAt: string
  updatedAt: string
  grants: ToolGrantRecord[]
}

export type ToolGrantRecord = {
  id: string
  toolId: string
  state: ToolGrantState
  config: Record<string, unknown>
  source: ToolGrantSource
  roleId: string | null
  agentId: string | null
  createdAt: string
  updatedAt: string
}

export type ToolRegistryFilters = {
  status?: ToolRegistryEntryStatus
  source?: ToolRegistrySource
  scopeKey?: string
}

const TOOL_REGISTRY_KEY = ['mcp-tools'] as const

const buildSearch = (filters: ToolRegistryFilters): string => {
  const params = new URLSearchParams()
  if (filters.status) params.set('status', filters.status)
  if (filters.source) params.set('source', filters.source)
  if (filters.scopeKey) params.set('scopeKey', filters.scopeKey)
  const serialised = params.toString()
  return serialised ? `?${serialised}` : ''
}

export const useMcpToolRegistry = (
  filters: ToolRegistryFilters = {},
  enabled = true,
) => {
  const apiClient = useApiClient()
  const search = buildSearch(filters)

  return useQuery<McpToolRegistryRecord[]>({
    queryKey: [
      ...TOOL_REGISTRY_KEY,
      filters.status ?? null,
      filters.source ?? null,
      filters.scopeKey ?? null,
    ],
    queryFn: () => apiClient.get(`/api/mcp/tools${search}`),
    enabled,
  })
}

export type CreateGrantInput = {
  toolRegistryEntryId: string
  state?: ToolGrantState
  config?: Record<string, unknown>
  roleId?: string | null
  agentId?: string | null
}

export const useCreateToolGrant = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: CreateGrantInput) => {
      const { toolRegistryEntryId, ...body } = input
      return apiClient.post<ToolGrantRecord>(
        `/api/mcp/tools/${toolRegistryEntryId}/grants`,
        body,
      )
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: TOOL_REGISTRY_KEY })
    },
  })
}

export const useDeleteToolGrant = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: { toolRegistryEntryId: string; grantId: string }) =>
      apiClient.delete(
        `/api/mcp/tools/${input.toolRegistryEntryId}/grants/${input.grantId}`,
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: TOOL_REGISTRY_KEY })
    },
  })
}
