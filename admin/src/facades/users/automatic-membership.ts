/* eslint-disable max-len -- concise facade declarations mirror one API operation each. */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { AutomaticMembershipRule, AutomaticMembershipRulesResponse } from '@nessie/schemas'
import { useApiClient } from '../../providers/ApiClientProvider'
import type { MemberRosterScope } from './member-roster'

export type AutomaticMembershipPermissions = {
  manageRules: boolean
  manageClaim?: boolean
}

export type AutomaticMembershipBackfill = {
  status: 'queued' | 'running' | 'paused' | 'completed' | 'completed_with_failures' | 'failed' | 'cancelled' | 'superseded'
  processedCount: number
  grantedCount: number
  failedCount: number
  nextRetryAt?: string | null
  updatedAt: string
}

export type AutomaticMembershipAuditEvent = {
  id: string
  action: string
  createdAt: string
  detail?: string | null
}

export type AutomaticMembershipRuleView = AutomaticMembershipRule & {
  dns?: { name: string; value: string } | null
  targetTeams?: Array<{ id: string; name: string }>
  backfill?: AutomaticMembershipBackfill | null
  auditEvents?: AutomaticMembershipAuditEvent[]
}

/** Aggregate-only UI contract; matching identities remain exclusively in UOA. */
export type AutomaticMembershipRulesView = AutomaticMembershipRulesResponse & {
  permissions?: AutomaticMembershipPermissions
  rules: AutomaticMembershipRuleView[]
}

export type AutomaticMembershipTeam = { id: string; name: string }

const path = (scope: MemberRosterScope) =>
  `/api/${scope === 'organization' ? 'organization' : 'team'}/automatic-membership`
const key = (scope: MemberRosterScope) => ['automatic-membership', scope] as const

export const useAutomaticMembershipRules = (scope: MemberRosterScope) => {
  const api = useApiClient()
  return useQuery({
    queryKey: key(scope),
    queryFn: () => api.get<AutomaticMembershipRulesView>(path(scope)),
    // Only running/queued reconciliation needs refresh; completed history is
    // stable and must not turn the Members page into a background poller.
    refetchInterval: (query) => query.state.data?.rules.some((rule) =>
      rule.backfill?.status === 'queued' || rule.backfill?.status === 'running',
    ) ? 5_000 : false,
  })
}

const useRuleMutation = <TInput, TResult>(scope: MemberRosterScope, run: (api: ReturnType<typeof useApiClient>, input: TInput) => Promise<TResult>) => {
  const api = useApiClient()
  const client = useQueryClient()
  return useMutation({ mutationFn: (input: TInput) => run(api, input), onSuccess: () => void client.invalidateQueries({ queryKey: key(scope) }) })
}

export const useCreateAutomaticMembershipRule = (scope: MemberRosterScope) =>
  useRuleMutation(scope, (api, input: { domain: string; notificationEmail?: string; targetTeamIds?: string[] }) => api.post(path(scope), input))
export const useUpdateAutomaticMembershipRule = (scope: MemberRosterScope) =>
  useRuleMutation(scope, (api, input: { ruleId: string; notificationEmail: string | null; targetTeamIds?: string[] }) => api.patch(`${path(scope)}/${input.ruleId}`, input))
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
export const useReleaseAutomaticMembershipClaim = (scope: MemberRosterScope) =>
  useRuleMutation(scope, (api, input: { ruleId: string }) => api.post(`${path(scope)}/${input.ruleId}/release`, {}))

export const useAutomaticMembershipTeams = (enabled: boolean) => {
  const api = useApiClient()
  return useQuery({
    enabled,
    queryKey: ['automatic-membership', 'organization', 'teams'],
    queryFn: () => api.get<{ teams: AutomaticMembershipTeam[] }>('/api/organization/automatic-membership/teams'),
  })
}
