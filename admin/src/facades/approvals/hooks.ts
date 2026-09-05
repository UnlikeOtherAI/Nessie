import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ApprovalRequestRecord, EmailDraftPreview } from '@nessie/schemas'

import { approvalKeys } from '../../lib/query-keys'
import { useApiClient } from '../../providers/ApiClientProvider'

// The server-enforced shape (`ApprovalRequestRecordSchema`, parsed on every
// response in `api/src/routes/approvals.ts`) rather than a hand-copied type,
// so a field the server adds or removes cannot silently drift from what this
// client reads.
export type ApprovalRequest = ApprovalRequestRecord

export type PendingApprovalCount = { count: number }

export const useApprovalRequests = (enabled = true) => {
  const apiClient = useApiClient()
  return useQuery<ApprovalRequest[]>({
    enabled,
    queryKey: approvalKeys.all,
    queryFn: () => apiClient.get('/api/approvals?limit=50'),
  })
}

/** A card resolves its opaque id through the same entitlement-scoped API as /approvals. */
export const useApprovalRequest = (approvalId: string | undefined) => {
  const apiClient = useApiClient()
  return useQuery<ApprovalRequest>({
    enabled: Boolean(approvalId),
    queryKey: approvalKeys.detail(approvalId),
    queryFn: () => apiClient.get(`/api/approvals/${approvalId}`),
    placeholderData: keepPreviousData,
  })
}

type MailSendToolName = 'gmail_draft_send' | 'mailbox_send'

/** The exact frozen send, visible only to its pinned approver. */
export const useMailSendApprovalDraft = (
  toolName: MailSendToolName | undefined,
  approvalId: string | undefined,
  active: boolean,
) => {
  const apiClient = useApiClient()
  return useQuery<EmailDraftPreview>({
    enabled: Boolean(approvalId && toolName && active),
    queryKey: approvalKeys.mailSendDraft(toolName ?? 'mailbox_send', approvalId),
    queryFn: () => apiClient.get(toolName === 'gmail_draft_send'
      ? `/api/gmail/drafts/approvals/${approvalId}/draft`
      : `/api/mailbox-connections/approvals/${approvalId}/draft`),
    // A different approval can contain somebody else's complete private email.
    // Never paint the previous approval while this exact identity resolves.
    placeholderData: undefined,
  })
}

/** The sidebar badge answers the one decision it represents: is something waiting on me? */
export const usePendingApprovalCount = (enabled = true) => {
  const apiClient = useApiClient()
  return useQuery<PendingApprovalCount>({
    enabled,
    queryKey: approvalKeys.pendingCount,
    queryFn: () => apiClient.get('/api/approvals/pending/count'),
  })
}

export const useResolveApproval = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: { id: string; resolution: 'approved' | 'rejected' }) =>
      apiClient.post(`/api/approvals/${input.id}/resolve`, { resolution: input.resolution }),
    onSuccess: (_data, input) => {
      void queryClient.invalidateQueries({ queryKey: approvalKeys.all })
      queryClient.removeQueries({ queryKey: approvalKeys.mailSendDraft('mailbox_send', input.id) })
      queryClient.removeQueries({ queryKey: approvalKeys.mailSendDraft('gmail_draft_send', input.id) })
    },
  })
}
