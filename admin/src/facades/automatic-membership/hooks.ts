/**
 * Automatic team access after sign-in — the facade both surfaces read through.
 *
 * The read is parameterised by scope, because the organisation and team
 * endpoints answer the same shape from different subsets of the data. The
 * mutations are not: every one of them except the team toggle is an
 * organisation-level act, so its path is fixed and a scope argument would only
 * be a place to make a mistake.
 *
 * Nothing is optimistic. DNS results and UOA's verdict are the authority, so
 * every mutation invalidates and re-reads rather than guessing.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { AutomaticMembershipResponse } from '@nessie/schemas'

import { automaticMembershipKeys } from './keys'
import { useApiClient } from '../../providers/ApiClientProvider'

export type AutomaticMembershipScope = 'organization' | 'team'

const basePath = (scope: AutomaticMembershipScope): string =>
  scope === 'organization'
    ? '/api/organization/automatic-membership'
    : '/api/team/automatic-membership'

const ORG_PATH = '/api/organization/automatic-membership'

/**
 * A reconciliation run is the one thing here that changes without the person
 * doing anything, so the query polls while one is active and stops when it is
 * not. No realtime event is added: `WsEventSchema` is a closed union, so a new
 * event would be a schema change plus a scope decision plus a client
 * subscription, for a counter that settles in minutes.
 */
const POLL_INTERVAL_MS = 4_000

export const useAutomaticMembership = (
  scope: AutomaticMembershipScope,
  enabled = true,
) => {
  const apiClient = useApiClient()

  return useQuery<AutomaticMembershipResponse>({
    enabled,
    queryFn: () => apiClient.get(basePath(scope)),
    queryKey: automaticMembershipKeys.forScope(scope),
    refetchInterval: (query) => {
      const running = query.state.data?.domains.some(
        (domain) => domain.reconciliation?.status === 'queued'
          || domain.reconciliation?.status === 'running',
      )
      return running ? POLL_INTERVAL_MS : false
    },
  })
}

/**
 * Both scopes' keys are invalidated on every success, deliberately: an
 * organisation admin detaching a team changes what that team's own tab shows.
 */
const useAutomaticMembershipMutation = <TInput, TResult>(
  run: (apiClient: ReturnType<typeof useApiClient>, input: TInput) => Promise<TResult>,
) => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: TInput) => run(apiClient, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: automaticMembershipKeys.all })
    },
  })
}

export const useSetAutomaticMembershipEnabled = () =>
  useAutomaticMembershipMutation<{ enabled: boolean }, { enabled: boolean }>(
    (apiClient, input) => apiClient.put(`${ORG_PATH}/enabled`, input),
  )

export const useAddAutomaticMembershipDomain = () =>
  useAutomaticMembershipMutation<{ domain: string }, { id: string; domain: string }>(
    (apiClient, input) => apiClient.post(`${ORG_PATH}/domains`, input),
  )

export const useVerifyAutomaticMembershipDomain = () =>
  useAutomaticMembershipMutation<{ id: string }, { kind: string }>(
    (apiClient, input) => apiClient.post(`${ORG_PATH}/domains/${input.id}/verify`),
  )

export const useRotateAutomaticMembershipChallenge = () =>
  useAutomaticMembershipMutation<{ id: string }, { challenge: string }>(
    (apiClient, input) => apiClient.post(`${ORG_PATH}/domains/${input.id}/rotate-challenge`),
  )

export const useSetAutomaticMembershipDomainStatus = () =>
  useAutomaticMembershipMutation<{ id: string; status: 'active' | 'suspended' }, { status: string }>(
    (apiClient, input) =>
      apiClient.patch(`${ORG_PATH}/domains/${input.id}`, { status: input.status }),
  )

export const useRevokeAutomaticMembershipDomain = () =>
  useAutomaticMembershipMutation<{ id: string }, { ok: boolean }>(
    (apiClient, input) => apiClient.delete(`${ORG_PATH}/domains/${input.id}`),
  )

export const useSetAutomaticMembershipTeams = () =>
  useAutomaticMembershipMutation<{ id: string; teamIds: string[] }, { added: number }>(
    (apiClient, input) =>
      apiClient.put(`${ORG_PATH}/domains/${input.id}/teams`, { teamIds: input.teamIds }),
  )

/** The team surface's single toggle: this team, on or off, for one domain. */
export const useSetTeamAutomaticMembership = () =>
  useAutomaticMembershipMutation<{ id: string; enabled: boolean }, { enabled: boolean }>(
    (apiClient, input) =>
      apiClient.put(`/api/team/automatic-membership/domains/${input.id}`, {
        enabled: input.enabled,
      }),
  )

/**
 * Scoped, unlike the other mutations: a team administrator repairs their own
 * team's rule through the team route, because the organisation one is
 * organisation-admin gated and would only ever refuse them.
 */
export const useReauthorizeAutomaticMembershipRule = (scope: AutomaticMembershipScope) =>
  useAutomaticMembershipMutation<{ ruleId: string }, { ok: boolean }>(
    (apiClient, input) => apiClient.post(
      scope === 'organization'
        ? `${ORG_PATH}/rules/${input.ruleId}/reauthorize`
        : `/api/team/automatic-membership/rules/${input.ruleId}/reauthorize`,
    ),
  )

export const useStartAutomaticMembershipReconciliation = () =>
  useAutomaticMembershipMutation<{ id: string }, { id?: string; started: boolean }>(
    (apiClient, input) => apiClient.post(`${ORG_PATH}/domains/${input.id}/reconciliations`),
  )

export const useCancelAutomaticMembershipReconciliation = () =>
  useAutomaticMembershipMutation<{ reconciliationId: string }, { ok: boolean }>(
    (apiClient, input) =>
      apiClient.delete(`${ORG_PATH}/reconciliations/${input.reconciliationId}`),
  )
