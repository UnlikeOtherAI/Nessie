import { useQuery } from '@tanstack/react-query'
import type {
  AgentModelOption,
  AgentActivityResponse,
  AgentChild,
  AgentMessage,
  AgentStatusResponse,
  ToolCallEntry,
} from '@nessie/schemas'
import type { AgentRecord } from '../../lib/api-client'
import { useApiClient } from '../../providers/ApiClientProvider'

export const useAgents = () => {
  const apiClient = useApiClient()

  return useQuery<AgentRecord[]>({
    queryKey: ['agents'],
    queryFn: () => apiClient.get('/api/agents'),
  })
}

export const useAgentModelOptions = () => {
  const apiClient = useApiClient()

  return useQuery<AgentModelOption[]>({
    queryKey: ['agents', 'models'],
    queryFn: () => apiClient.get('/api/agents/models'),
    staleTime: 60_000,
  })
}

export const useAgentStatus = (agentId?: string) => {
  const apiClient = useApiClient()

  return useQuery<AgentStatusResponse>({
    queryKey: ['agents', agentId, 'status'],
    queryFn: () => apiClient.get(`/api/agents/${agentId}/status`),
    enabled: Boolean(agentId),
  })
}

export const useAgentActivity = (agentId?: string) => {
  const apiClient = useApiClient()

  return useQuery<AgentActivityResponse>({
    queryKey: ['agents', agentId, 'activity'],
    queryFn: () => apiClient.get(`/api/agents/${agentId}/activity`),
    enabled: Boolean(agentId),
  })
}

export const useAgentMessages = (agentId?: string, limit = 5, offset = 0) => {
  const apiClient = useApiClient()

  return useQuery<AgentMessage[]>({
    queryKey: ['agents', agentId, 'messages', limit, offset],
    queryFn: () => apiClient.get(`/api/agents/${agentId}/messages?limit=${limit}&offset=${offset}`),
    enabled: Boolean(agentId),
  })
}

export const useAgentChildren = (agentId?: string) => {
  const apiClient = useApiClient()

  return useQuery<AgentChild[]>({
    queryKey: ['agents', agentId, 'children'],
    queryFn: () => apiClient.get(`/api/agents/${agentId}/children`),
    enabled: Boolean(agentId),
  })
}

export const useRunToolCalls = (agentId?: string, runId?: string) => {
  const apiClient = useApiClient()

  return useQuery<ToolCallEntry[]>({
    queryKey: ['agents', agentId, 'runs', runId, 'tools'],
    queryFn: () => apiClient.get(`/api/agents/${agentId}/runs/${runId}/tools`),
    enabled: Boolean(agentId && runId),
  })
}
