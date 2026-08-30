import {
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import type {
  McpCatalogAuthMethod,
  McpCatalogProtocol,
  McpCatalogStatus,
  McpCatalogVisibility,
  McpServerAuthConfig,
} from '@nessie/schemas'
import { mcpKeys } from '../../lib/query-keys'
import { useApiClient } from '../../providers/ApiClientProvider'

/**
 * Domain facade for `McpCatalogEntry` (the "MCP App Store" catalog). Backs the
 * `/admin/admin/mcp-app-store` surface.
 *
 * Wire shape mirrors `api/src/services/mcp-catalog.ts > McpCatalogEntryRow`
 * with timestamps left as ISO strings (the api-client envelope strips the
 * `data` wrapper before this layer sees it).
 */

/** Which slice of the catalog to load (mirrors the API `view` query param). */
export type CatalogView = 'store' | 'mine' | 'queue' | 'all'

export type McpCatalogEntryRecord = {
  id: string
  organizationId: string | null
  managedByIntegration: boolean
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
  visibility: McpCatalogVisibility
  locked: boolean
  lockedAt: string | null
  lockedBy: string | null
  ownerUserId: string | null
  submittedAt: string | null
  reviewedAt: string | null
  reviewedBy: string | null
  rejectionReason: string | null
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
}>

const buildSearch = (filters: { view?: CatalogView; status?: McpCatalogStatus }): string => {
  const params = new URLSearchParams()
  if (filters.view) params.set('view', filters.view)
  if (filters.status) params.set('status', filters.status)
  const query = params.toString()
  return query ? `?${query}` : ''
}

export const useMcpCatalog = (
  filters: { view?: CatalogView; status?: McpCatalogStatus } = {},
  options: { enabled?: boolean } = {},
) => {
  const apiClient = useApiClient()
  const search = buildSearch(filters)

  return useQuery<McpCatalogEntryRecord[]>({
    queryKey: mcpKeys.catalogList(filters.view ?? 'store', filters.status ?? null),
    queryFn: () => apiClient.get(`/api/mcp/catalog${search}`),
    enabled: options.enabled ?? true,
  })
}

const invalidateCatalog = (queryClient: ReturnType<typeof useQueryClient>) =>
  queryClient.invalidateQueries({ queryKey: mcpKeys.catalog })

export const useCreateCatalogEntry = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: CreateCatalogEntryInput) =>
      apiClient.post<McpCatalogEntryRecord>('/api/mcp/catalog', input),
    onSuccess: () => {
      void invalidateCatalog(queryClient)
    },
  })
}

export const useUpdateCatalogEntry = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: { id: string } & UpdateCatalogEntryInput) => {
      const { id, ...body } = input
      return apiClient.patch<McpCatalogEntryRecord>(`/api/mcp/catalog/${id}`, body)
    },
    onSuccess: () => {
      void invalidateCatalog(queryClient)
    },
  })
}

export const useDeleteCatalogEntry = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (id: string) => apiClient.delete(`/api/mcp/catalog/${id}`),
    onSuccess: () => {
      void invalidateCatalog(queryClient)
    },
  })
}

/**
 * Lifecycle transitions go through dedicated POST endpoints rather than a
 * status PATCH so each carries its own authorization rules:
 * - `publish` / `deprecate` — owner of a private connector (self-serve);
 * - `submit` — owner of an entry asks for public listing;
 * - `approve` / `reject` — superuser decisions on the pending queue.
 */
const useCatalogAction = <TBody = void>(action: string) => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: ({ id, body }: { id: string; body?: TBody }) =>
      apiClient.post<McpCatalogEntryRecord>(`/api/mcp/catalog/${id}/${action}`, body ?? {}),
    onSuccess: () => {
      void invalidateCatalog(queryClient)
    },
  })
}

export const useLockCatalogEntry = () => {
  const action = useCatalogAction('lock')
  return { ...action, mutateAsync: (id: string) => action.mutateAsync({ id }) }
}

export const useUnlockCatalogEntry = () => {
  const action = useCatalogAction('unlock')
  return { ...action, mutateAsync: (id: string) => action.mutateAsync({ id }) }
}

export const usePublishCatalogEntry = () => {
  const action = useCatalogAction('publish')
  return { ...action, mutateAsync: (id: string) => action.mutateAsync({ id }) }
}

export const useDeprecateCatalogEntry = () => {
  const action = useCatalogAction('deprecate')
  return { ...action, mutateAsync: (id: string) => action.mutateAsync({ id }) }
}

export const useSubmitCatalogEntry = () => {
  const action = useCatalogAction('submit')
  return { ...action, mutateAsync: (id: string) => action.mutateAsync({ id }) }
}

export const useApproveCatalogEntry = () => {
  const action = useCatalogAction('approve')
  return { ...action, mutateAsync: (id: string) => action.mutateAsync({ id }) }
}

export const useRejectCatalogEntry = () => {
  const action = useCatalogAction<{ reason: string }>('reject')
  return {
    ...action,
    mutateAsync: (input: { id: string; reason: string }) =>
      action.mutateAsync({ id: input.id, body: { reason: input.reason } }),
  }
}
