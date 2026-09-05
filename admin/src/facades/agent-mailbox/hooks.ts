import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ApiClientError } from '@nessie/client-core'
import type {
  AgentMailboxRecord,
  AgentMailboxSendPolicy,
  ApiResponse,
  CreateAgentMailboxBody,
  EmailConversationRecord,
  EmailMessageRecord,
} from '@nessie/schemas'

import { useApiClient } from '../../providers/ApiClientProvider'

/**
 * The hosted mailbox surface. Every read is entitlement-scoped server-side by
 * the shared agent-visibility predicate, so these hooks pass an agent id and
 * nothing else — no ambient project/team narrowing.
 */

export const agentMailboxKeys = {
  config: () => ['agent-email', 'config'] as const,
  conversation: (agentId: string | undefined, conversationId: string | undefined) =>
    ['agent-email', 'conversation', agentId, conversationId] as const,
  conversations: (agentId: string | undefined, filter: string, cursor?: string) =>
    ['agent-email', 'conversations', agentId, filter, cursor ?? null] as const,
  draft: (approvalId: string | undefined) => ['agent-email', 'draft', approvalId] as const,
  mailbox: (agentId: string | undefined) => ['agent-email', 'mailbox', agentId] as const,
}

export type AgentEmailConfig = {
  available: boolean
  domain?: string
  customDomains?: boolean
  /** Owner-only: exactly which variables the deployment is missing. */
  missing?: string[]
  reason?: string
}

export const useAgentEmailConfig = () => {
  const apiClient = useApiClient()
  return useQuery<AgentEmailConfig>({
    queryFn: () => apiClient.get('/api/agent-email/config'),
    queryKey: agentMailboxKeys.config(),
    staleTime: 5 * 60_000,
  })
}

export const useAgentMailbox = (agentId: string | undefined) => {
  const apiClient = useApiClient()
  return useQuery<AgentMailboxRecord | null>({
    enabled: Boolean(agentId),
    // Arriving with content: switching agents keeps the previous mailbox on
    // screen instead of flashing an empty section.
    placeholderData: keepPreviousData,
    queryFn: async () => {
      try {
        return await apiClient.get<AgentMailboxRecord>(`/api/agents/${agentId}/mailbox`)
      } catch (error) {
        // No mailbox is a legitimate steady state, not an error to surface.
        if (error instanceof ApiClientError && error.status === 404) return null
        throw error
      }
    },
    queryKey: agentMailboxKeys.mailbox(agentId),
  })
}

export const useMailboxConversations = (
  agentId: string | undefined,
  filter: 'all' | 'inbox' | 'sent',
  cursor?: string,
) => {
  const apiClient = useApiClient()
  // getPage, not get: the cursors and the total live in the envelope's `meta`,
  // which `get` throws away.
  return useQuery<ApiResponse<EmailConversationRecord[]>>({
    enabled: Boolean(agentId),
    placeholderData: keepPreviousData,
    queryFn: () => {
      const params = new URLSearchParams({ filter })
      if (cursor) params.set('cursor', cursor)
      return apiClient.getPage<EmailConversationRecord[]>(
        `/api/agents/${agentId}/mailbox/conversations?${params.toString()}`,
      )
    },
    queryKey: agentMailboxKeys.conversations(agentId, filter, cursor),
  })
}

export const useMailboxConversation = (
  agentId: string | undefined,
  conversationId: string | undefined,
) => {
  const apiClient = useApiClient()
  return useQuery<EmailMessageRecord[]>({
    enabled: Boolean(agentId && conversationId),
    placeholderData: keepPreviousData,
    queryFn: () =>
      apiClient.get(
        `/api/agents/${agentId}/mailbox/conversations/${conversationId}/messages`,
      ),
    queryKey: agentMailboxKeys.conversation(agentId, conversationId),
  })
}

export const useCreateMailbox = (agentId: string | undefined) => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: CreateAgentMailboxBody) =>
      apiClient.post<AgentMailboxRecord>(`/api/agents/${agentId}/mailbox`, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: agentMailboxKeys.mailbox(agentId) })
    },
  })
}

export const useUpdateMailbox = (agentId: string | undefined) => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: { sendPolicy?: AgentMailboxSendPolicy; displayName?: string | null }) =>
      apiClient.patch<AgentMailboxRecord>(`/api/agents/${agentId}/mailbox`, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: agentMailboxKeys.mailbox(agentId) })
    },
  })
}

export const useDeleteMailbox = (agentId: string | undefined) => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => apiClient.delete(`/api/agents/${agentId}/mailbox`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: agentMailboxKeys.mailbox(agentId) })
    },
  })
}
