import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { TeamMembersResponse } from '@nessie/schemas'
import { organizationKeys } from '../../lib/query-keys'
import { useApiClient } from '../../providers/ApiClientProvider'

/**
 * The organisation-wide roster on a UnlikeOtherAI session: every member of the
 * UOA organisation with their ORG role, read live from UOA — never scoped to
 * the session's active team. This is the seam the "Organization → Members"
 * settings page reads; the team-scoped roster keeps using
 * `./team-members` (`/api/team/members`), which is the correct
 * source for a team surface. The two were once conflated and the org page
 * silently showed one team's roster — see
 * docs/plans/2026-08-31-identity-belonging-audit.md.
 */

export const useOrganizationMembers = (enabled = true) => {
  const apiClient = useApiClient()

  return useQuery<TeamMembersResponse>({
    enabled,
    queryKey: organizationKeys.members,
    queryFn: () => apiClient.get('/api/organization/members'),
  })
}

/** Every mutation re-reads the roster: UOA is the only state there is. */
const useOrganizationMutation = <TInput>(
  run: (apiClient: ReturnType<typeof useApiClient>, input: TInput) => Promise<unknown>,
) => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: TInput) => run(apiClient, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: organizationKeys.members })
    },
  })
}

export const useUpdateOrganizationMemberRole = () =>
  useOrganizationMutation<{ uoaSub: string; role: string }>((apiClient, input) =>
    apiClient.put(`/api/organization/members/${encodeURIComponent(input.uoaSub)}/role`, {
      role: input.role,
    }))

export const useSetOrganizationMemberActivation = () =>
  useOrganizationMutation<{ uoaSub: string; deactivated: boolean }>((apiClient, input) =>
    apiClient.post(
      `/api/organization/members/${encodeURIComponent(input.uoaSub)}/`
      + `${input.deactivated ? 'deactivate' : 'reactivate'}`,
      {},
    ))
