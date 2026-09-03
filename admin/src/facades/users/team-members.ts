import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  CreateTeamInvitationsRequest,
  CreateTeamInvitationsResponse,
  TeamInvitationsResponse,
  TeamMembersResponse,
} from '@nessie/schemas'
import { teamKeys } from '../../lib/query-keys'
import { useApiClient } from '../../providers/ApiClientProvider'

/**
 * The team roster and its invitations on a UnlikeOtherAI session. Every
 * record is served live from UOA and nothing is persisted locally, so these
 * queries are the only source — there is no local list to fall back to. People
 * are addressed by their UOA subject, never a local user id.
 *
 * The local (non-UOA) member list keeps using `./hooks`.
 */


export const useTeamMembers = (enabled = true) => {
  const apiClient = useApiClient()

  return useQuery<TeamMembersResponse>({
    enabled,
    queryKey: teamKeys.members,
    queryFn: () => apiClient.get('/api/team/members'),
  })
}

export const useTeamInvitations = (enabled = true) => {
  const apiClient = useApiClient()

  return useQuery<TeamInvitationsResponse>({
    enabled,
    queryKey: teamKeys.invitations,
    queryFn: () => apiClient.get('/api/team/invitations'),
  })
}

/** Every mutation below re-reads both lists: UOA is the only state there is. */
const useTeamMutation = <TInput>(
  run: (apiClient: ReturnType<typeof useApiClient>, input: TInput) => Promise<unknown>,
) => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: TInput) => run(apiClient, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: teamKeys.members })
      void queryClient.invalidateQueries({ queryKey: teamKeys.invitations })
    },
  })
}

export const useUpdateTeamMemberRole = () =>
  useTeamMutation<{ uoaSub: string; role: string }>((apiClient, input) =>
    apiClient.put(`/api/team/members/${encodeURIComponent(input.uoaSub)}/role`, {
      role: input.role,
    }))

export const useRemoveTeamMember = () =>
  useTeamMutation<{ uoaSub: string }>((apiClient, input) =>
    apiClient.delete(`/api/team/members/${encodeURIComponent(input.uoaSub)}`))

export const useSetTeamMemberActivation = () =>
  useTeamMutation<{ uoaSub: string; deactivated: boolean }>((apiClient, input) =>
    apiClient.post(
      `/api/team/members/${encodeURIComponent(input.uoaSub)}/`
      + `${input.deactivated ? 'deactivate' : 'reactivate'}`,
      {},
    ))

export const useCreateTeamInvitations = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: CreateTeamInvitationsRequest) =>
      apiClient.post<CreateTeamInvitationsResponse>('/api/team/invitations', input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: teamKeys.invitations })
    },
  })
}

export const useResendTeamInvitation = () =>
  useTeamMutation<{ inviteId: string }>((apiClient, input) =>
    apiClient.post(
      `/api/team/invitations/${encodeURIComponent(input.inviteId)}/resend`,
      {},
    ))

/**
 * Withdraw an invitation that was already sent. Idempotent upstream, so a
 * second click is still a success; an invitation that was already accepted
 * answers `409 INVITATION_ALREADY_ACCEPTED` and the row says so.
 */
export const useRevokeTeamInvitation = () =>
  useTeamMutation<{ inviteId: string }>((apiClient, input) =>
    apiClient.post(
      `/api/team/invitations/${encodeURIComponent(input.inviteId)}/revoke`,
      {},
    ))

/**
 * Approve or deny an invitation raised by a member while the organisation
 * requires review. Deny is the review verb for an invitation that was never
 * sent; `useRevokeTeamInvitation` withdraws one that was.
 */
export const useReviewTeamInvitation = () =>
  useTeamMutation<{ inviteId: string; action: 'approve' | 'deny' }>((apiClient, input) =>
    apiClient.post(
      `/api/team/invitations/${encodeURIComponent(input.inviteId)}/${input.action}`,
      {},
    ))
