import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { AgentRunLimits } from '@nessie/schemas'
import type { AgentRecord } from '../../lib/api-client'
import { useApiClient } from '../../providers/ApiClientProvider'

export const useCreateAgent = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: {
      effort?: 'low' | 'medium' | 'high' | 'xhigh'
      model?: string
      name: string
      parentAgentId?: string
      provider?: string
      role: string
      // Omitted leaves the agent on the deployment backstop only.
      runLimits?: AgentRunLimits
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
      effort?: 'low' | 'medium' | 'high' | 'xhigh'
      model?: string
      name?: string
      provider?: string
      role?: string
      // Omitted leaves the stored limits untouched; `null` clears them.
      runLimits?: AgentRunLimits | null
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

export const useUpdateAgentAvatar = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: { agentId: string; avatarAttachmentId: string | null }) =>
      apiClient.patch<AgentRecord>(`/api/agents/${input.agentId}/avatar`, {
        avatarAttachmentId: input.avatarAttachmentId,
      }),
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
