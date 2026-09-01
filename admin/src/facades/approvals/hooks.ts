import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { approvalKeys } from '../../lib/query-keys'
import { useApiClient } from '../../providers/ApiClientProvider'

export type ApprovalRequest = {
  action: string
  agentId: string
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

export const useApprovalRequests = (enabled = true) => {
  const apiClient = useApiClient()
  return useQuery<ApprovalRequest[]>({
    enabled,
    queryKey: approvalKeys.all,
    queryFn: () => apiClient.get('/api/approvals?limit=50'),
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
