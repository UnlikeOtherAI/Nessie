import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'

import { teamProvisioningKeys } from '../../lib/query-keys'
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

type CreateInput = { name: string; slug?: string; idempotencyKey: string }

/** Why UOA will not accept an address, in UOA's own vocabulary. */
export type SlugUnavailableReason =
  | 'taken'
  | 'too_short'
  | 'too_long'
  | 'charset'
  | 'double_hyphen'
  | 'all_digits'
  | 'reserved'

export type SlugAvailability = {
  /** `null` means UOA could not be reached — unknown, not unavailable. */
  available: boolean | null
  slug?: string
  reason?: SlugUnavailableReason
}

/**
 * Whether an address is free.
 *
 * Every rule lives in UOA, which owns the labels; Nessie deliberately keeps no
 * second copy of them, so even "too short" is UOA's answer rather than a local
 * guess that could drift out of step with the authority that decides.
 */
export const useSlugAvailability = (input: {
  slug: string
  scope: 'organisation' | 'team'
  orgId?: string
  enabled: boolean
}) => {
  const apiClient = useApiClient()

  return useQuery({
    queryKey: teamProvisioningKeys.slugAvailability(input.scope, input.orgId ?? '', input.slug),
    enabled: input.enabled && input.slug.length > 0,
    // The field debounces by not asking until typing pauses; this keeps a
    // recently-answered label from being asked again on every render.
    staleTime: 30_000,
    // Hold the previous answer while the next one is in flight, so the status
    // line under the field does not blank out between keystrokes. Nothing
    // private is replayed — the answer is a yes/no about a label the person is
    // currently typing.
    placeholderData: keepPreviousData,
    retry: false,
    queryFn: () => {
      const query = new URLSearchParams({ slug: input.slug, scope: input.scope })
      if (input.orgId) query.set('orgId', input.orgId)
      return apiClient.get<SlugAvailability>(`/api/teams/slug-available?${query.toString()}`)
    },
  })
}

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
