import {
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import type {
  AgentToolPolicyTarget,
  SetAgentToolPolicyEntryRequest,
  SetToolRegistryStatusRequest,
  SetToolRegistryStatusResponse,
  ToolGrantSource,
  ToolGrantState,
  ToolRegistryEntryStatus,
  ToolRegistrySource,
  ToolRegistryTransport,
} from '@nessie/schemas'
import { useIsOwner } from '../auth/hooks'
import { useApiClient } from '../../providers/ApiClientProvider'
import { useAuthSession } from '../../providers/AuthSessionProvider'
import {
  deepWaterAgentAccessKeyPrefix,
  mcpKeys,
  mcpToolRegistryKey,
  toolPolicyTargetsKey,
  toolPolicyTargetsKeyPrefix,
} from '../integrations/keys'

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
  managedProductSlug: string | null
  policyKey: string
  requiresExplicitGrant: boolean
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
  const { me } = useAuthSession()
  const isOwner = useIsOwner()
  const search = buildSearch(filters)
  const scope = me
    ? {
        isOwner,
        organizationId: me.context.organizationId,
        teamId: me.context.teamId,
        userId: me.user.id,
      }
    : null

  return useQuery<McpToolRegistryRecord[]>({
    queryKey: scope
      ? mcpToolRegistryKey(scope, enabled, filters)
      : [...mcpKeys.tools, 'signed-out'],
    queryFn: () => apiClient.get(`/api/mcp/tools${search}`),
    enabled: enabled && scope !== null,
  })
}

export const useAgentToolPolicyTargets = (enabled = true) => {
  const apiClient = useApiClient()
  const { me } = useAuthSession()
  const isOwner = useIsOwner()
  const scope = me
    ? {
        isOwner,
        organizationId: me.context.organizationId,
        userId: me.user.id,
      }
    : null

  return useQuery<AgentToolPolicyTarget[]>({
    queryKey: scope
      ? toolPolicyTargetsKey(scope)
      : [...toolPolicyTargetsKeyPrefix, 'signed-out'],
    queryFn: () => apiClient.get('/api/mcp/tools/policy-targets'),
    enabled: enabled && scope !== null,
  })
}

export const useSetAgentToolPolicyEntry = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (
      input: SetAgentToolPolicyEntryRequest & {
        agentId: string
        toolRegistryEntryId: string
      },
    ) =>
      apiClient.patch<AgentToolPolicyTarget>(
        `/api/mcp/tools/${input.toolRegistryEntryId}/policy-targets/${input.agentId}`,
        { enabled: input.enabled },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: toolPolicyTargetsKeyPrefix,
      })
      void queryClient.invalidateQueries({
        queryKey: deepWaterAgentAccessKeyPrefix,
      })
    },
  })
}

/**
 * Owner review verdict on discovered MCP tools.
 *
 * Bulk by design — a connector routinely projects dozens of tools — but the
 * caller always names the exact ids, so what the reviewer had on screen is
 * exactly what changes.
 */
export const useSetToolRegistryStatus = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: SetToolRegistryStatusRequest) =>
      apiClient.post<SetToolRegistryStatusResponse>(
        '/api/mcp/tools/status',
        input,
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: mcpKeys.tools })
    },
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
      void queryClient.invalidateQueries({
        queryKey: mcpKeys.tools,
      })
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
      void queryClient.invalidateQueries({
        queryKey: mcpKeys.tools,
      })
    },
  })
}
