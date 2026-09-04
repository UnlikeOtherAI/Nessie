import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { EmailDraftPreview } from '@nessie/schemas'

import { approvalKeys } from '../../lib/query-keys'
import { useApiClient } from '../../providers/ApiClientProvider'

export type ApprovalRequest = {
  action: string
  agentId: string
  channelId: string | null
  context?: Record<string, unknown>
  createdAt: string
  expiresAt: string
  id: string
  reason: string
  requesterId: string
  resolution: string | null
  resolutionNote: string | null
  resolverId: string | null
  status: string
}

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

/** The exact frozen connected-mail send, visible only to its pinned approver. */
export const useMailboxSendApprovalDraft = (approvalId: string | undefined) => {
  const apiClient = useApiClient()
  return useQuery<EmailDraftPreview>({
    enabled: Boolean(approvalId),
    queryKey: approvalKeys.mailboxSendDraft(approvalId),
    queryFn: () => apiClient.get(`/api/mailbox-connections/approvals/${approvalId}/draft`),
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
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: approvalKeys.all })
    },
  })
}
