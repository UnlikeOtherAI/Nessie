import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { MessageSearchResult, ThreadMessageRecord } from '../../lib/api-client'
import { uploadAttachment, type AttachmentRecord } from '../../lib/uploads'
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
    } & SendMessageThreadExtras) =>
      apiClient.post<SendMessageResponse>(`/api/threads/${threadId}/messages`, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['threads', threadId, 'messages'] })
      void queryClient.invalidateQueries({ queryKey: ['threads', threadId, 'replies'] })
      void queryClient.resetQueries({ queryKey: ['threads', 'activity'] })
    },
  })
}

export const useSendMessageToThread = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: { attachmentIds?: string[]; content: string; threadId: string }) =>
      apiClient.post<SendMessageResponse>(`/api/threads/${input.threadId}/messages`, {
        attachmentIds: input.attachmentIds,
        content: input.content,
      }),
    onSuccess: (_message, input) => {
      void queryClient.invalidateQueries({
        queryKey: ['threads', input.threadId, 'messages'],
      })
      void queryClient.invalidateQueries({ queryKey: ['channels'] })
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
      void queryClient.invalidateQueries({ queryKey: ['threads', threadId, 'messages'] })
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
      void queryClient.invalidateQueries({ queryKey: ['threads', threadId, 'messages'] })
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
      void queryClient.invalidateQueries({ queryKey: ['threads', threadId, 'messages'] })
    },
  })
}

export const useMessageSearch = (channelId: string | undefined, query: string) => {
  const apiClient = useApiClient()
  const trimmed = query.trim()

  return useQuery<MessageSearchResult[]>({
    queryKey: ['channels', channelId, 'messages', 'search', trimmed],
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
      messageId: string
      kind: 'message' | 'scope'
      duration: DisclosureDuration
    }) =>
      apiClient.post<{ kind: string }>(
        `/api/messages/${input.messageId}/disclosure-grants`,
        { duration: input.duration, kind: input.kind },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['threads', threadId, 'messages'] })
    },
  })
}
