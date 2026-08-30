import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { mcpKeys } from '../../lib/query-keys'
import { useApiClient } from '../../providers/ApiClientProvider'
import type { McpCatalogEntryRecord } from '../mcp-catalog/hooks'

/**
 * Domain facade for the public MCP server library + endpoint discovery:
 * `GET /api/mcp/library` (curated list + official registry search),
 * `POST /api/mcp/library/import` (turn a library entry / discovery proposal
 * into an org catalog entry), `POST /api/mcp/discover` (probe a pasted link)
 * and `POST /api/mcp/instances/:id/secret` (store a credential encrypted).
 */

export type McpLibraryTransport = 'http' | 'sse'
export type McpLibraryAuthMethod = 'none' | 'bearer' | 'api_key' | 'oauth2'

export type McpLibraryEntryRecord = {
  source: 'curated' | 'registry'
  key: string
  name: string
  label: string
  description: string
  vendor: string | null
  sourceUrl: string | null
  url: string
  transport: McpLibraryTransport
  authMethod: McpLibraryAuthMethod
  authHint: string | null
}

export type McpLibraryResponse = {
  entries: McpLibraryEntryRecord[]
  registryError: string | null
}

export type McpDiscoveryAttemptRecord = {
  url: string
  transport: McpLibraryTransport
  outcome: 'ok' | 'auth_required' | 'unreachable' | 'not_mcp' | 'blocked'
  detail: string | null
  toolCount?: number
}

export type McpDiscoveryResultRecord = {
  input: string
  ok: boolean
  proposal: {
    url: string
    transport: McpLibraryTransport
    authMethod: McpLibraryAuthMethod
    toolNames: string[]
    note: string | null
  } | null
  attempts: McpDiscoveryAttemptRecord[]
}

export type ImportLibraryEntryInput = {
  entry: {
    name: string
    label: string
    description?: string
    url: string
    transport: McpLibraryTransport
    authMethod: McpLibraryAuthMethod
    vendor?: string | null
    sourceUrl?: string | null
  }
  publish?: boolean
  shareToOrg?: boolean
}

export const useMcpLibrary = (search: string, options: { enabled?: boolean } = {}) => {
  const apiClient = useApiClient()
  const params = new URLSearchParams()
  if (search.trim()) params.set('search', search.trim())
  const serialised = params.toString()

  return useQuery<McpLibraryResponse>({
    queryKey: mcpKeys.librarySearch(search.trim()),
    queryFn: () => apiClient.get(`/api/mcp/library${serialised ? `?${serialised}` : ''}`),
    enabled: options.enabled ?? true,
    staleTime: 60_000,
  })
}

export const useImportLibraryEntry = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: ImportLibraryEntryInput) =>
      apiClient.post<McpCatalogEntryRecord>('/api/mcp/library/import', input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: mcpKeys.catalog })
    },
  })
}

export const useDiscoverMcpEndpoint = () => {
  const apiClient = useApiClient()

  return useMutation({
    mutationFn: (input: { url: string }) =>
      apiClient.post<McpDiscoveryResultRecord>('/api/mcp/discover', input),
  })
}

export const useStartInstanceOAuth = () => {
  const apiClient = useApiClient()

  return useMutation({
    mutationFn: (input: { instanceId: string }) =>
      apiClient.post<{ authorizationUrl: string; state: string; mode: 'static' | 'dynamic' }>(
        `/api/mcp/instances/${input.instanceId}/oauth/start`,
        {},
      ),
  })
}

export const useSetInstanceSecret = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: { instanceId: string; secret: string; shared?: boolean }) =>
      apiClient.post<{ placement: string }>(`/api/mcp/instances/${input.instanceId}/secret`, {
        secret: input.secret,
        shared: input.shared,
      }),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({ queryKey: mcpKeys.instances })
      void queryClient.invalidateQueries({
        queryKey: mcpKeys.instanceCredentials(variables.instanceId),
      })
    },
  })
}
