import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { AgentRecord } from '../../lib/api-client'
import { useApiClient } from '../../providers/ApiClientProvider'

export const useCreateAgent = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: {
      model?: string
      name: string
      parentAgentId?: string
      provider?: string
      role: string
      systemPrompt?: string
      toolPolicy?: Record<string, boolean>
    }) =>
      apiClient.post<AgentRecord>('/api/agents', input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['agents'] })
    },
  })
}

export const useUpdateAgent = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: {
      agentId: string
      model?: string
      name?: string
      provider?: string
      role?: string
      systemPrompt?: string
      toolPolicy?: Record<string, boolean>
    }) => {
      const { agentId, ...body } = input
      return apiClient.put<AgentRecord>(`/api/agents/${agentId}`, body)
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['agents'] })
    },
  })
}

export const useBindAgent = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: { agentId: string; channelId: string }) =>
      apiClient.post(`/api/agents/${input.agentId}/bindings`, {
        channelId: input.channelId,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['agents'] })
    },
  })
}

export const useUnbindAgent = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: { agentId: string; channelId: string }) =>
      apiClient.delete(
        `/api/agents/${input.agentId}/bindings/${input.channelId}`,
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['agents'] })
    },
  })
}

export const useCloneAgent = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (agentId: string) =>
      apiClient.post<AgentRecord>(`/api/agents/${agentId}/clone`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['agents'] })
    },
  })
}
