import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { AgentConversationRecord, AgentMention } from '@nessie/schemas'
import type { MessageSearchResult, ThreadMessageRecord } from '../../lib/api-client'
import { uploadAttachment, type AttachmentRecord } from '../../lib/uploads'
import { agentKeys } from '../agents/keys'
import { channelKeys } from '../channels/keys'
import { threadKeys } from '../threads/keys'
import { useApiClient } from '../../providers/ApiClientProvider'
import { useAuthSession } from '../../providers/AuthSessionProvider'

/** An agent @mentioned in a message that is not a member of the channel. */
export interface PendingAgentInvite {
  id: string
  name: string
}

/** Response of POST /api/threads/:threadId/messages. */
export interface SendMessageResponse {
  message: ThreadMessageRecord
  pendingAgentInvites: PendingAgentInvite[]
  /**
   * The name this send just gave the conversation, reported by the 201 on
   * exactly the send that named a still-unnamed thread — the first top-level
   * message (`api/src/routes/thread-message-create.ts`). Additive and
   * optional: every other send omits it.
   */
  conversationTitle?: string
}

/**
 * The conversation record a naming send implies, given what is cached.
 *
 * Pure so the rule is checkable without a client: the title lands on a record
 * that is already there, an absent cache stays absent (the next read fetches
 * the whole record rather than inventing one from a title), and a send that
 * named nothing changes nothing. Returning the same reference when the title
 * already agrees keeps the header from re-rendering for no reason.
 */
export const applyConversationTitle = <Record extends { title: string }>(
  cached: Record | undefined,
  title: string | undefined,
): Record | undefined => {
  if (!title || cached === undefined) return cached
  if (cached.title === title) return cached
  return { ...cached, title }
}

/** Extra routing fields for posting a reply into a message thread (#233). */
export interface SendMessageThreadExtras {
  rootMessageId?: string
  alsoSendToChannel?: boolean
}

export const useSendMessage = (threadId?: string) => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: {
      content: string
      attachmentIds?: string[]
      agentMentions?: AgentMention[]
      // Idempotency key for this unsent draft: a retried send resolves to the
      // message the first attempt created instead of posting a second one.
      clientMessageId?: string
    } & SendMessageThreadExtras) =>
      apiClient.post<SendMessageResponse>(`/api/threads/${threadId}/messages`, input),
    onSuccess: (response) => {
      void queryClient.invalidateQueries({ queryKey: threadKeys.messages(threadId) })
      void queryClient.invalidateQueries({ queryKey: threadKeys.replies(threadId) })
      // Stronger than the invalidation the naming case below would otherwise
      // ask for, and it runs on every send: a new message can move records
      // across keyset page boundaries.
      void queryClient.resetQueries({ queryKey: threadKeys.activityRoot })
      // The send that named the conversation is the only reader told the name
      // at the moment it exists. Without this the header goes on saying "New
      // conversation" to the very person who just named it, until the list's
      // poll or a reload catches up — `threadKeys.conversation` is otherwise
      // written only by `useRenameThread`.
      const title = response?.conversationTitle
      if (title) {
        const key = threadKeys.conversation(threadId)
        queryClient.setQueryData<AgentConversationRecord>(
          key,
          (cached) => applyConversationTitle(cached, title),
        )
        // The rail beside the conversation and the agent page's own tab list
        // the same rows. The agent is read from the record the header is
        // already rendering; with no record cached there is nothing to read it
        // from, so the whole agent family is refreshed instead.
        const agentId = queryClient.getQueryData<AgentConversationRecord>(key)?.agentId
        void queryClient.invalidateQueries({
          queryKey: agentId ? agentKeys.conversations(agentId) : agentKeys.all,
        })
      }
    },
  })
}

export const useSendMessageToThread = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: {
      agentMentions?: AgentMention[]
      attachmentIds?: string[]
      content: string
      threadId: string
    }) =>
      apiClient.post<SendMessageResponse>(`/api/threads/${input.threadId}/messages`, {
        agentMentions: input.agentMentions,
        attachmentIds: input.attachmentIds,
        content: input.content,
      }),
    onSuccess: (_message, input) => {
      void queryClient.invalidateQueries({
        queryKey: threadKeys.messages(input.threadId),
      })
      void queryClient.invalidateQueries({ queryKey: channelKeys.all })
    },
  })
}

// sp-messaging slice: edit, delete, and full-text search.
export const useUpdateMessage = (threadId?: string) => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: { messageId: string; content: string }) =>
      apiClient.patch<ThreadMessageRecord>(
        `/api/threads/${threadId}/messages/${input.messageId}`,
        { content: input.content },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: threadKeys.messages(threadId) })
    },
  })
}

export const useDeleteMessage = (threadId?: string) => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (messageId: string) =>
      apiClient.delete<ThreadMessageRecord>(
        `/api/threads/${threadId}/messages/${messageId}`,
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: threadKeys.messages(threadId) })
    },
  })
}

export const useAddMessageReaction = (threadId?: string) => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: { emoji: string; messageId: string }) =>
      apiClient.post<{ ok: boolean }>(
        `/api/threads/${threadId}/messages/${input.messageId}/reactions`,
        { emoji: input.emoji },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: threadKeys.messages(threadId) })
    },
  })
}

export const useMessageSearch = (channelId: string | undefined, query: string) => {
  const apiClient = useApiClient()
  const trimmed = query.trim()

  return useQuery<MessageSearchResult[]>({
    placeholderData: keepPreviousData,
    queryKey: channelKeys.messageSearch(channelId, trimmed),
    queryFn: () =>
      apiClient.get(
        `/api/channels/${channelId}/messages/search?query=${encodeURIComponent(trimmed)}`,
      ),
    enabled: Boolean(channelId) && trimmed.length > 0,
  })
}

// Upload a file (multipart) and return the created attachment record. Uses the
// raw fetch helper because the JSON ApiClient cannot send FormData bodies.
export const useUploadAttachment = () => {
  const { token } = useAuthSession()
  return useMutation({
    mutationFn: (file: File): Promise<AttachmentRecord> => uploadAttachment(file, token),
  })
}

// Discard an upload that was staged in the composer and then removed before the
// message was sent. The server accepts this only for the uploader's own
// attachment while it is still unlinked, and frees the stored bytes.
export const useDiscardAttachment = () => {
  const apiClient = useApiClient()
  return useMutation({
    mutationFn: (attachmentId: string) =>
      apiClient.delete<null>(`/api/attachments/${attachmentId}`),
  })
}

/** Duration presets the acknowledgement card offers for a standing rule. */
export type DisclosureDuration = '10m' | 'today' | '30d' | 'forever'

/**
 * Answer the acknowledgement card: share one restricted reply, or stand up a
 * rule allowing this agent to use these sources in this channel.
 *
 * The server re-checks that the caller currently reaches the message's sources
 * — this hook only asks. A refusal surfaces on the card.
 */
export const useShareRestrictedMessage = (threadId?: string) => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: {
      expectedContent: string
      messageId: string
      kind: 'message' | 'scope'
      duration: DisclosureDuration
    }) =>
      apiClient.post<{ kind: string }>(
        `/api/messages/${input.messageId}/disclosure-grants`,
        input.kind === 'message'
          ? {
              duration: input.duration,
              expectedContent: input.expectedContent,
              kind: input.kind,
            }
          : { duration: input.duration, kind: input.kind },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: threadKeys.messages(threadId) })
    },
  })
}
