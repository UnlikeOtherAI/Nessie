import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  AgentTriggerDeliveryRecord,
  AgentTriggerRecord,
} from '../../lib/api-client'
import { useApiClient } from '../../providers/ApiClientProvider'

export const useTriggers = (enabled = true) => {
  const apiClient = useApiClient()

  return useQuery<AgentTriggerRecord[]>({
    queryKey: ['triggers'],
    queryFn: () => apiClient.get('/api/triggers'),
    enabled,
  })
}

export const useAgentTriggers = (agentId?: string, enabled = true) => {
  const apiClient = useApiClient()

  return useQuery<AgentTriggerRecord[]>({
    queryKey: ['agents', agentId, 'triggers'],
    queryFn: () => apiClient.get(`/api/agents/${agentId}/triggers`),
    enabled: enabled && Boolean(agentId),
  })
}

export const useTriggerHistory = (triggerId?: string, limit = 10) => {
  const apiClient = useApiClient()

  return useQuery<AgentTriggerDeliveryRecord[]>({
    queryKey: ['triggers', triggerId, 'history', limit],
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
      void queryClient.invalidateQueries({ queryKey: ['triggers'] })
      void queryClient.invalidateQueries({ queryKey: ['agents'] })
      void queryClient.invalidateQueries({
        queryKey: ['agents', variables.agentId, 'triggers'],
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
      void queryClient.invalidateQueries({ queryKey: ['triggers'] })
      void queryClient.invalidateQueries({ queryKey: ['agents'] })
    },
  })
}

export const useResumeTrigger = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (triggerId: string) => apiClient.post(`/api/triggers/${triggerId}/resume`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['triggers'] })
      void queryClient.invalidateQueries({ queryKey: ['agents'] })
    },
  })
}

/**
 * Put a schedule back to work after its captured identity stopped verifying.
 *
 * `takeOver` is the owner's explicit "run this as me instead"; without it the
 * server refuses to re-point a schedule at a different workspace, because that
 * would move its billing attribution as a side effect of a repair click.
 */
export const useReauthorizeTrigger = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: { takeOver?: boolean; triggerId: string }) =>
      apiClient.post(`/api/triggers/${input.triggerId}/reauthorize`, {
        ...(input.takeOver === undefined ? {} : { takeOver: input.takeOver }),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['triggers'] })
      void queryClient.invalidateQueries({ queryKey: ['agents'] })
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
      void queryClient.invalidateQueries({ queryKey: ['triggers'] })
      void queryClient.invalidateQueries({ queryKey: ['agents'] })
      void queryClient.invalidateQueries({ queryKey: ['workflow-installations'] })
    },
  })
}

export const useDeleteTrigger = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (triggerId: string) => apiClient.delete(`/api/triggers/${triggerId}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['triggers'] })
      void queryClient.invalidateQueries({ queryKey: ['agents'] })
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
      void queryClient.invalidateQueries({ queryKey: ['triggers'] })
      void queryClient.invalidateQueries({
        queryKey: ['workflow-installations', variables.installationId, 'triggers'],
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
      void queryClient.invalidateQueries({ queryKey: ['triggers'] })
      void queryClient.invalidateQueries({ queryKey: ['agents'] })
      void queryClient.invalidateQueries({ queryKey: ['runs'] })
    },
  })
}
