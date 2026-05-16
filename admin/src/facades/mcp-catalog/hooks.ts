import {
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import type {
  McpCatalogAuthMethod,
  McpCatalogProtocol,
  McpCatalogStatus,
  McpServerAuthConfig,
} from '@nessie/schemas'
import { useApiClient } from '../../providers/ApiClientProvider'

/**
 * Domain facade for `McpCatalogEntry` (the "MCP App Store" catalog). Backs the
 * `/admin/admin/mcp-app-store` surface listed in plan §7 and the architecture
 * doc §5.2 (one facade per entity, no page-local fetch).
 *
 * Wire shape mirrors `api/src/services/mcp-catalog.ts > McpCatalogEntryRow`
 * with timestamps left as ISO strings (the api-client envelope strips the
 * `data` wrapper before this layer sees it).
 */

export type McpCatalogEntryRecord = {
  id: string
  organizationId: string | null
  name: string
  label: string
  description: string
  protocol: McpCatalogProtocol
  authMethod: McpCatalogAuthMethod
  authConfig: McpServerAuthConfig
  defaultTransportConfig: Record<string, unknown>
  iconUrl: string | null
  vendor: string | null
  sourceUrl: string | null
  signature: string | null
  status: McpCatalogStatus
  createdBy: string
  createdAt: string
  updatedAt: string
}

export type CreateCatalogEntryInput = {
  name: string
  label: string
  description?: string
  protocol: McpCatalogProtocol
  authMethod: McpCatalogAuthMethod
  authConfig: McpServerAuthConfig
  defaultTransportConfig?: Record<string, unknown>
  iconUrl?: string | null
  vendor?: string | null
  sourceUrl?: string | null
  signature?: string | null
  organizationId?: string | null
}

export type UpdateCatalogEntryInput = Partial<{
  label: string
  description: string
  protocol: McpCatalogProtocol
  authMethod: McpCatalogAuthMethod
  authConfig: McpServerAuthConfig
  defaultTransportConfig: Record<string, unknown>
  iconUrl: string | null
  vendor: string | null
  sourceUrl: string | null
  signature: string | null
  status: McpCatalogStatus
}>

const CATALOG_QUERY_KEY = ['mcp-catalog'] as const

export const useMcpCatalog = (
  filters: { status?: McpCatalogStatus } = {},
  options: { enabled?: boolean } = {},
) => {
  const apiClient = useApiClient()
  const search = filters.status ? `?status=${filters.status}` : ''

  return useQuery<McpCatalogEntryRecord[]>({
    queryKey: [...CATALOG_QUERY_KEY, filters.status ?? null],
    queryFn: () => apiClient.get(`/api/mcp/catalog${search}`),
    enabled: options.enabled ?? true,
  })
}

export const useCreateCatalogEntry = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: CreateCatalogEntryInput) =>
      apiClient.post<McpCatalogEntryRecord>('/api/mcp/catalog', input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: CATALOG_QUERY_KEY })
    },
  })
}

export const useUpdateCatalogEntry = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: { id: string } & UpdateCatalogEntryInput) => {
      const { id, ...body } = input
      return apiClient.patch<McpCatalogEntryRecord>(
        `/api/mcp/catalog/${id}`,
        body,
      )
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: CATALOG_QUERY_KEY })
    },
  })
}

/**
 * Publish / deprecate are status transitions. We expose them as discrete hooks
 * so callers don't have to remember the magic enum value.
 */
export const usePublishCatalogEntry = () => {
  const update = useUpdateCatalogEntry()
  return {
    ...update,
    mutateAsync: (id: string) => update.mutateAsync({ id, status: 'published' }),
  }
}

export const useDeprecateCatalogEntry = () => {
  const update = useUpdateCatalogEntry()
  return {
    ...update,
    mutateAsync: (id: string) =>
      update.mutateAsync({ id, status: 'deprecated' }),
  }
}

export const useDeleteCatalogEntry = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (id: string) => apiClient.delete(`/api/mcp/catalog/${id}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: CATALOG_QUERY_KEY })
    },
  })
}
