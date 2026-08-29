import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  AgentTriggerDeliveryRecord,
  AgentTriggerRecord,
} from '../../lib/api-client'
import { agentKeys, runKeys, triggerKeys, workflowKeys } from '../../lib/query-keys'
import { useApiClient } from '../../providers/ApiClientProvider'

export const useTriggers = (enabled = true) => {
  const apiClient = useApiClient()

  return useQuery<AgentTriggerRecord[]>({
    queryKey: triggerKeys.all,
    queryFn: () => apiClient.get('/api/triggers'),
    enabled,
  })
}

export const useAgentTriggers = (agentId?: string, enabled = true) => {
  const apiClient = useApiClient()

  return useQuery<AgentTriggerRecord[]>({
    queryKey: agentKeys.triggers(agentId),
    queryFn: () => apiClient.get(`/api/agents/${agentId}/triggers`),
    enabled: enabled && Boolean(agentId),
  })
}

export const useTriggerHistory = (triggerId?: string, limit = 10) => {
  const apiClient = useApiClient()

  return useQuery<AgentTriggerDeliveryRecord[]>({
    queryKey: triggerKeys.history(triggerId, limit),
    queryFn: () => apiClient.get(`/api/triggers/${triggerId}/history?limit=${limit}`),
    enabled: Boolean(triggerId),
  })
}

export const useCreateAgentTrigger = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: {
      agentId: string
      type: AgentTriggerRecord['type']
      name?: string
      description?: string
      enabled?: boolean
      config?: Record<string, unknown>
      nextRunAt?: string
      targetChannelId?: string
      targetThreadId?: string
    }) =>
      apiClient.post<AgentTriggerRecord>(`/api/agents/${input.agentId}/triggers`, {
        type: input.type,
        name: input.name,
        description: input.description,
        enabled: input.enabled,
        config: input.config,
        nextRunAt: input.nextRunAt,
        targetChannelId: input.targetChannelId,
        targetThreadId: input.targetThreadId,
      }),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({ queryKey: triggerKeys.all })
      void queryClient.invalidateQueries({ queryKey: agentKeys.all })
      void queryClient.invalidateQueries({
        queryKey: agentKeys.triggers(variables.agentId),
      })
    },
  })
}

export const usePauseTrigger = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (triggerId: string) => apiClient.post(`/api/triggers/${triggerId}/pause`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: triggerKeys.all })
      void queryClient.invalidateQueries({ queryKey: agentKeys.all })
    },
  })
}

export const useResumeTrigger = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (triggerId: string) => apiClient.post(`/api/triggers/${triggerId}/resume`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: triggerKeys.all })
      void queryClient.invalidateQueries({ queryKey: agentKeys.all })
    },
  })
}

export const useUpdateTrigger = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: {
      triggerId: string
      name?: string | null
      description?: string | null
      enabled?: boolean
      status?: AgentTriggerRecord['status']
      config?: Record<string, unknown>
      nextRunAt?: string | null
      targetChannelId?: string | null
      targetThreadId?: string | null
    }) => {
      const { triggerId, ...body } = input
      return apiClient.put<AgentTriggerRecord>(`/api/triggers/${triggerId}`, body)
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: triggerKeys.all })
      void queryClient.invalidateQueries({ queryKey: agentKeys.all })
      void queryClient.invalidateQueries({ queryKey: workflowKeys.installations })
    },
  })
}

export const useDeleteTrigger = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (triggerId: string) => apiClient.delete(`/api/triggers/${triggerId}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: triggerKeys.all })
      void queryClient.invalidateQueries({ queryKey: agentKeys.all })
    },
  })
}

export const useCreateWorkflowInstallationTrigger = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: {
      installationId: string
      type: AgentTriggerRecord['type']
      name?: string
      description?: string
      enabled?: boolean
      config?: Record<string, unknown>
      nextRunAt?: string
    }) =>
      apiClient.post<AgentTriggerRecord>(
        `/api/workflow-installations/${input.installationId}/triggers`,
        {
          type: input.type,
          name: input.name,
          description: input.description,
          enabled: input.enabled,
          config: input.config,
          nextRunAt: input.nextRunAt,
        },
      ),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({ queryKey: triggerKeys.all })
      void queryClient.invalidateQueries({
        queryKey: workflowKeys.installationTriggers(variables.installationId),
      })
    },
  })
}

export const useFireTrigger = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: { payload?: unknown; prompt?: string; triggerId: string }) =>
      apiClient.post(`/api/triggers/${input.triggerId}/fire`, {
        dedupeKey: crypto.randomUUID(),
        payload: input.payload,
        prompt: input.prompt,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: triggerKeys.all })
      void queryClient.invalidateQueries({ queryKey: agentKeys.all })
      void queryClient.invalidateQueries({ queryKey: runKeys.all })
    },
  })
}
