import { useMutation, useQueryClient } from '@tanstack/react-query'
import { AgentRecordSchema } from '@nessie/schemas'
import type {
  AgentAvatarBackgroundColor,
  AgentConversationRecord,
  AgentRunLimits,
} from '@nessie/schemas'
import type { AgentRecord, ThreadMessageRecord } from '../../lib/api-client'
import { agentKeys } from './keys'
import { channelKeys } from '../channels/keys'
import { threadKeys } from '../threads/keys'
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
      todosEnabled?: boolean
      // `null` on either is the explicit "no choice": the deployment default
      // voice, and no speaking-style block.
      voiceName?: string | null
      speakingStyle?: string | null
      toolPolicy?: Record<string, boolean>
      visibility?: AgentRecord['visibility']
    }) =>
      apiClient.post<AgentRecord>('/api/agents', input, undefined, AgentRecordSchema),
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
      /**
       * Ownership transitions: a user id transfers stewardship, `null` releases
       * the agent to the team. Narrower than the rest of this body — the server
       * accepts it only from the current owner or an organisation owner.
       */
      ownerUserId?: string | null
      provider?: string
      role?: string
      // Omitted leaves the stored limits untouched; `null` clears them.
      runLimits?: AgentRunLimits | null
      systemPrompt?: string
      todosEnabled?: boolean
      voiceName?: string | null
      speakingStyle?: string | null
      toolPolicy?: Record<string, boolean>
    }) => {
      const { agentId, ...body } = input
      return apiClient.put<AgentRecord>(
        `/api/agents/${agentId}`,
        body,
        undefined,
        AgentRecordSchema,
      )
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
      }, undefined, AgentRecordSchema),
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

export type StartAgentConversationResult = {
  conversation: AgentConversationRecord
  /** Null when the conversation was started empty, which is the rail's case. */
  message: ThreadMessageRecord | null
}

/**
 * Start a fresh conversation with an agent.
 *
 * The body is the shared `StartAgentConversationBodySchema`, which is
 * `.strict()` and `.optional()` throughout: a field that is not being sent is
 * *omitted*, never sent as `null` (see `zod .strict() .optional() rejects
 * null`). The three lists a new thread changes are refreshed — the agent's own
 * conversations, the Threads inbox, and the channel list, whose unread counts
 * now sum every thread of a room.
 */
export const useStartAgentConversation = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    // Plain strings rather than the wire schema's branded ids: this is the
    // JSON body, and the server is the one that parses it. Every field is
    // omitted rather than sent as `null` when absent — the body schema is
    // `.strict()` and `.optional()`, which rejects an explicit null.
    mutationFn: (input: {
      agentId: string
      channelId?: string
      title?: string
      message?: string
      clientMessageId?: string
    }) => {
      const { agentId, ...body } = input
      return apiClient.post<StartAgentConversationResult>(
        `/api/agents/${encodeURIComponent(agentId)}/conversations`,
        body,
      )
    },
    onSuccess: (_result, input) => {
      void queryClient.invalidateQueries({ queryKey: agentKeys.conversations(input.agentId) })
      void queryClient.invalidateQueries({ queryKey: threadKeys.activityRoot })
      void queryClient.invalidateQueries({ queryKey: channelKeys.all })
    },
  })
}

export const useCloneAgent = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (agentId: string) =>
      apiClient.post<AgentRecord>(
        `/api/agents/${agentId}/clone`,
        undefined,
        undefined,
        AgentRecordSchema,
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: agentKeys.all })
    },
  })
}
