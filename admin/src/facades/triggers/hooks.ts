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

export const useUpcomingTriggers = (enabled = true) => {
  const apiClient = useApiClient()

  return useQuery<AgentTriggerRecord[]>({
    queryKey: ['triggers', 'upcoming'],
    queryFn: () => apiClient.get('/api/triggers/scheduled?limit=50'),
    enabled,
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
