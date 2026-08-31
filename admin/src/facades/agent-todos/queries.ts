import { useQuery } from '@tanstack/react-query'
import type { AgentTodoRecord, AgentTodoTemplateRecord } from '@nessie/schemas'

import { useApiClient } from '../../providers/ApiClientProvider'
import { agentTodoKeys } from './keys'

export const useAgentTodoTemplates = (
  agentId?: string,
  options?: { enabled?: boolean; includeArchived?: boolean },
) => {
  const apiClient = useApiClient()
  const includeArchived = options?.includeArchived ?? false

  return useQuery<AgentTodoTemplateRecord[]>({
    queryKey: agentTodoKeys.templates(agentId, includeArchived),
    queryFn: () => apiClient.get(
      `/api/agents/${agentId}/todo-templates${includeArchived ? '?includeArchived=true' : ''}`,
    ),
    enabled: (options?.enabled ?? true) && Boolean(agentId),
  })
}

export const useAgentTodos = (agentId?: string, enabled = true) => {
  const apiClient = useApiClient()

  return useQuery<AgentTodoRecord[]>({
    queryKey: agentTodoKeys.instances(agentId),
    queryFn: () => apiClient.get(`/api/agents/${agentId}/todos`),
    enabled: enabled && Boolean(agentId),
  })
}
