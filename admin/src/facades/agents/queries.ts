import { useQuery } from '@tanstack/react-query'
import type {
  AgentModelOption,
  AgentActivityResponse,
  AgentChild,
  AgentDocumentsResponse,
  AgentMessage,
  AgentStatusResponse,
  ToolCallEntry,
} from '@nessie/schemas'
import type { AgentRecord } from '../../lib/api-client'
import { agentKeys } from '../../lib/query-keys'
import { useApiClient } from '../../providers/ApiClientProvider'

export type AgentListScope = 'all' | 'visible'

export type PausedPrivateAgentCount = { count: number }

/**
 * The agents the caller is entitled to see. Default (`visible`) is the
 * non-system list every surface has always used. `all` additionally pulls the
 * read-only system tier (Personal Assistant + `systemManaged` agents) via
 * `?scope=all`, for the Agents page's Personal / Global tabs; it is cached
 * under its own key so it never overwrites the default list the rest of the app
 * reads.
 */
export const useAgents = (options?: { scope?: AgentListScope }) => {
  const apiClient = useApiClient()
  const scope = options?.scope ?? 'visible'

  return useQuery<AgentRecord[]>({
    queryKey: scope === 'all' ? agentKeys.allScopes : agentKeys.all,
    queryFn: () =>
      apiClient.get(scope === 'all' ? '/api/agents?scope=all' : '/api/agents'),
  })
}

/** Owner-only aggregate for the Members tree; it never fetches private rows. */
export const usePausedPrivateAgentCount = (enabled: boolean) => {
  const apiClient = useApiClient()

  return useQuery<PausedPrivateAgentCount>({
    enabled,
    queryKey: agentKeys.pausedPrivateCount,
    queryFn: () => apiClient.get('/api/agents/paused-private-count'),
  })
}

export const useAgentModelOptions = () => {
  const apiClient = useApiClient()

  return useQuery<AgentModelOption[]>({
    queryKey: agentKeys.models,
    queryFn: () => apiClient.get('/api/agents/models'),
    staleTime: 60_000,
  })
}

export const useAgentStatus = (agentId?: string) => {
  const apiClient = useApiClient()

  return useQuery<AgentStatusResponse>({
    queryKey: agentKeys.status(agentId),
    queryFn: () => apiClient.get(`/api/agents/${agentId}/status`),
    enabled: Boolean(agentId),
  })
}

export const useAgentActivity = (agentId?: string) => {
  const apiClient = useApiClient()

  return useQuery<AgentActivityResponse>({
    queryKey: agentKeys.activity(agentId),
    queryFn: () => apiClient.get(`/api/agents/${agentId}/activity`),
    enabled: Boolean(agentId),
  })
}

export const useAgentMessages = (agentId?: string, limit = 5, offset = 0) => {
  const apiClient = useApiClient()

  return useQuery<AgentMessage[]>({
    queryKey: agentKeys.messagePage(agentId, limit, offset),
    queryFn: () => apiClient.get(`/api/agents/${agentId}/messages?limit=${limit}&offset=${offset}`),
    enabled: Boolean(agentId),
  })
}

export const useAgentChildren = (agentId?: string) => {
  const apiClient = useApiClient()

  return useQuery<AgentChild[]>({
    queryKey: agentKeys.children(agentId),
    queryFn: () => apiClient.get(`/api/agents/${agentId}/children`),
    enabled: Boolean(agentId),
  })
}

export const useAgentDocuments = (agentId?: string) => {
  const apiClient = useApiClient()

  return useQuery<AgentDocumentsResponse>({
    queryKey: agentKeys.documents(agentId),
    queryFn: () => apiClient.get(`/api/agents/${agentId}/docs`),
    enabled: Boolean(agentId),
  })
}

export const useRunToolCalls = (agentId?: string, runId?: string) => {
  const apiClient = useApiClient()

  return useQuery<ToolCallEntry[]>({
    queryKey: agentKeys.runTools(agentId, runId),
    queryFn: () => apiClient.get(`/api/agents/${agentId}/runs/${runId}/tools`),
    enabled: Boolean(agentId && runId),
  })
}
