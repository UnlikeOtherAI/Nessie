import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  CreateWorkspaceInvitationsRequest,
  CreateWorkspaceInvitationsResponse,
  WorkspaceInvitationsResponse,
  WorkspaceMembersResponse,
} from '@nessie/schemas'
import { useApiClient } from '../../providers/ApiClientProvider'

/**
 * The workspace roster and its invitations on a UnlikeOtherAI session. Every
 * record is served live from UOA and nothing is persisted locally, so these
 * queries are the only source — there is no local list to fall back to. People
 * are addressed by their UOA subject, never a local user id.
 *
 * The local (non-UOA) member list keeps using `./hooks`.
 */

const MEMBERS_KEY = ['workspace', 'members'] as const
const INVITATIONS_KEY = ['workspace', 'invitations'] as const

export const useWorkspaceMembers = (enabled = true) => {
  const apiClient = useApiClient()

  return useQuery<WorkspaceMembersResponse>({
    enabled,
    queryKey: MEMBERS_KEY,
    queryFn: () => apiClient.get('/api/workspace/members'),
  })
}

export const useWorkspaceInvitations = (enabled = true) => {
  const apiClient = useApiClient()

  return useQuery<WorkspaceInvitationsResponse>({
    enabled,
    queryKey: INVITATIONS_KEY,
    queryFn: () => apiClient.get('/api/workspace/invitations'),
  })
}

/** Every mutation below re-reads both lists: UOA is the only state there is. */
const useWorkspaceMutation = <TInput>(
  run: (apiClient: ReturnType<typeof useApiClient>, input: TInput) => Promise<unknown>,
) => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: TInput) => run(apiClient, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: MEMBERS_KEY })
      void queryClient.invalidateQueries({ queryKey: INVITATIONS_KEY })
    },
  })
}

export const useUpdateWorkspaceMemberRole = () =>
  useWorkspaceMutation<{ uoaSub: string; role: string }>((apiClient, input) =>
    apiClient.put(`/api/workspace/members/${encodeURIComponent(input.uoaSub)}/role`, {
      role: input.role,
    }))

export const useRemoveWorkspaceMember = () =>
  useWorkspaceMutation<{ uoaSub: string }>((apiClient, input) =>
    apiClient.delete(`/api/workspace/members/${encodeURIComponent(input.uoaSub)}`))

export const useSetWorkspaceMemberActivation = () =>
  useWorkspaceMutation<{ uoaSub: string; deactivated: boolean }>((apiClient, input) =>
    apiClient.post(
      `/api/workspace/members/${encodeURIComponent(input.uoaSub)}/`
      + `${input.deactivated ? 'deactivate' : 'reactivate'}`,
      {},
    ))

export const useCreateWorkspaceInvitations = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: CreateWorkspaceInvitationsRequest) =>
      apiClient.post<CreateWorkspaceInvitationsResponse>('/api/workspace/invitations', input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: INVITATIONS_KEY })
    },
  })
}

export const useResendWorkspaceInvitation = () =>
  useWorkspaceMutation<{ inviteId: string }>((apiClient, input) =>
    apiClient.post(
      `/api/workspace/invitations/${encodeURIComponent(input.inviteId)}/resend`,
      {},
    ))

/**
 * Approve or deny an invitation raised by a member while the organisation
 * requires review. Deny is UOA's only stop verb — an invitation that has
 * already been sent cannot be cancelled through the UOA API.
 */
export const useReviewWorkspaceInvitation = () =>
  useWorkspaceMutation<{ inviteId: string; action: 'approve' | 'deny' }>((apiClient, input) =>
    apiClient.post(
      `/api/workspace/invitations/${encodeURIComponent(input.inviteId)}/${input.action}`,
      {},
    ))
