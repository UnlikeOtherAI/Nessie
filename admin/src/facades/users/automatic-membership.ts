/* eslint-disable max-len -- concise facade declarations mirror one API operation each. */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { AutomaticMembershipRulesResponse } from '@nessie/schemas'
import { useApiClient } from '../../providers/ApiClientProvider'
import type { MemberRosterScope } from './member-roster'

const path = (scope: MemberRosterScope) =>
  `/api/${scope === 'organization' ? 'organization' : 'team'}/automatic-membership`
const key = (scope: MemberRosterScope) => ['automatic-membership', scope] as const

export const useAutomaticMembershipRules = (scope: MemberRosterScope) => {
  const api = useApiClient()
  return useQuery({ queryKey: key(scope), queryFn: () => api.get<AutomaticMembershipRulesResponse>(path(scope)) })
}

const useRuleMutation = <TInput, TResult>(scope: MemberRosterScope, run: (api: ReturnType<typeof useApiClient>, input: TInput) => Promise<TResult>) => {
  const api = useApiClient()
  const client = useQueryClient()
  return useMutation({ mutationFn: (input: TInput) => run(api, input), onSuccess: () => void client.invalidateQueries({ queryKey: key(scope) }) })
}

export const useCreateAutomaticMembershipRule = (scope: MemberRosterScope) =>
  useRuleMutation(scope, (api, input: { domain: string; notificationEmail?: string; targetTeamIds?: string[] }) => api.post(path(scope), input))
export const useVerifyAutomaticMembershipRule = (scope: MemberRosterScope) =>
  useRuleMutation(scope, (api, input: { ruleId: string }) => api.post(`${path(scope)}/${input.ruleId}/verify`, {}))
export const useRotateAutomaticMembershipRule = (scope: MemberRosterScope) =>
  useRuleMutation(scope, (api, input: { ruleId: string }) => api.post(`${path(scope)}/${input.ruleId}/rotate`, {}))
export const useActivateAutomaticMembershipRule = (scope: MemberRosterScope) =>
  useRuleMutation(scope, (api, input: { ruleId: string }) => api.post(`${path(scope)}/${input.ruleId}/activate`, {}))
export const useRevokeAutomaticMembershipRule = (scope: MemberRosterScope) =>
  useRuleMutation(scope, (api, input: { ruleId: string }) => api.post(`${path(scope)}/${input.ruleId}/revoke`, {}))
export const useSuspendAutomaticMembershipRule = (scope: MemberRosterScope) =>
  useRuleMutation(scope, (api, input: { ruleId: string }) => api.post(`${path(scope)}/${input.ruleId}/suspend`, {}))

export const useAutomaticMembershipTeams = (enabled: boolean) => {
  const api = useApiClient()
  return useQuery({
    enabled,
    queryKey: ['automatic-membership', 'organization', 'teams'],
    queryFn: () => api.get<{ teams: Array<{ id: string; name: string }> }>('/api/organization/automatic-membership/teams'),
  })
}
