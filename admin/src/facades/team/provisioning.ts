import { useMutation } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'

import { useApiClient } from '../../providers/ApiClientProvider'
import { useAuthSession } from '../../providers/AuthSessionProvider'

/**
 * Creating an organisation or a team without leaving Nessie.
 *
 * Both mutations do the same three things in the same order — ask UOA to
 * create, switch onto what UOA answered, land in the new team — because
 * the second step is what materializes the local mirror. The switch is the
 * ordinary silent one the rail already uses; nothing here is a redirect.
 */

export type ProvisionedTeam = {
  externalOrgId: string
  externalTeamId: string
}

/**
 * A key identifying one creation *intent*, minted per attempt and reused on
 * every retry of it. The server records it, so a retry after an ambiguous
 * failure returns the organisation the first attempt made rather than founding
 * a second one.
 */
export const newIdempotencyKey = (): string =>
  globalThis.crypto?.randomUUID?.() ?? `k-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`

type CreateInput = { name: string; idempotencyKey: string }

const useProvisionAndSwitch = (path: string) => {
  const apiClient = useApiClient()
  const navigate = useNavigate()
  const { switchUoaTeam } = useAuthSession()

  return useMutation({
    mutationFn: async (input: CreateInput) => {
      const created = await apiClient.post<ProvisionedTeam>(path, input)
      // The local Organization/Team/Project/#general are born here, inside the
      // switch — never in the create call above. See the route's own note.
      await switchUoaTeam({
        organizationId: created.externalOrgId,
        teamId: created.externalTeamId,
      })
      void navigate('/channels', { replace: true })
      return created
    },
  })
}

/** Found a new UOA organisation, owned by the signed-in person. */
export const useCreateOrganization = () =>
  useProvisionAndSwitch('/api/teams/organizations')

/** Add a team to the organisation the person is currently in. */
export const useCreateTeamTeam = () =>
  useProvisionAndSwitch('/api/teams/teams')
