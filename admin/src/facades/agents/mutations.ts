import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { AgentAvatarBackgroundColor, AgentRunLimits } from '@nessie/schemas'
import type { AgentRecord } from '../../lib/api-client'
import { agentKeys } from '../../lib/query-keys'
import { useApiClient } from '../../providers/ApiClientProvider'

export const useCreateAgent = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: {
      avatarAttachmentId?: string
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
      visibility?: AgentRecord['visibility']
    }) =>
      apiClient.post<AgentRecord>('/api/agents', input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: agentKeys.all })
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
      void queryClient.invalidateQueries({ queryKey: agentKeys.all })
    },
  })
}

export const useUpdateAgentAvatar = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: {
      agentId: string
      avatarAttachmentId: string | null
      avatarBackgroundColor?: AgentAvatarBackgroundColor
    }) =>
      apiClient.patch<AgentRecord>(`/api/agents/${input.agentId}/avatar`, {
        avatarAttachmentId: input.avatarAttachmentId,
        ...(input.avatarBackgroundColor
          ? { avatarBackgroundColor: input.avatarBackgroundColor }
          : {}),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: agentKeys.all })
    },
  })
}

export const useGenerateAgentAvatar = () => {
  const apiClient = useApiClient()

  return useMutation({
    mutationFn: (input: {
      agentId: string
      name?: string
      role?: string
      systemPrompt?: string
      instructions?: string
    }) => {
      const { agentId, ...body } = input
      return apiClient.post<{
        avatarAttachmentId: string
        avatarBackgroundColor: AgentAvatarBackgroundColor
      }>(`/api/agents/${agentId}/avatar/generate`, body)
    },
  })
}

export const useBindAgent = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: { agentId: string; channelId: string; triggerMessageId?: string }) =>
      apiClient.post(`/api/agents/${input.agentId}/bindings`, {
        channelId: input.channelId,
        ...(input.triggerMessageId ? { triggerMessageId: input.triggerMessageId } : {}),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: agentKeys.all })
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
      void queryClient.invalidateQueries({ queryKey: agentKeys.all })
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
      void queryClient.invalidateQueries({ queryKey: agentKeys.all })
    },
  })
}
