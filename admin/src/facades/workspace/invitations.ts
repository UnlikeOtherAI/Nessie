import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { UoaPendingWorkspaceInvite } from '@nessie/schemas'
import { useNavigate } from 'react-router-dom'

import { alertKeys } from '../../lib/query-keys'
import { useApiClient } from '../../providers/ApiClientProvider'
import { useAuthSession } from '../../providers/AuthSessionProvider'

type AcceptWorkspaceInvitationResponse = {
  ok: true
  organizationId: string
  teamId: string
}

/** One acceptance path shared by the switcher, bell, and full alerts page. */
export const useAcceptWorkspaceInvitation = () => {
  const apiClient = useApiClient()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { switchUoaWorkspace } = useAuthSession()

  return useMutation({
    mutationFn: async (invite: UoaPendingWorkspaceInvite) => {
      const accepted = await apiClient.post<AcceptWorkspaceInvitationResponse>(
        `/api/workspace/invitations/${encodeURIComponent(invite.inviteId)}/accept`,
        {
          organizationId: invite.organizationId,
          teamId: invite.teamId,
        },
      )
      await switchUoaWorkspace({
        organizationId: accepted.organizationId,
        teamId: accepted.teamId,
      })
      void navigate('/channels', { replace: true })
      return accepted
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: alertKeys.all })
    },
  })
}
