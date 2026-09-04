import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  CreateMemberInvitationRequest,
  MemberInvitationTarget,
  MemberWorkspaceAccessResponse,
  MemberRosterPermissions,
  TeamInvitationRecord,
  TeamMemberCandidate,
  TeamMemberRecord,
} from '@nessie/schemas'

import { teamKeys, organizationKeys } from '../../lib/query-keys'
import { useApiClient } from '../../providers/ApiClientProvider'
import { usePagedList } from '../usePagedList'

export type MemberRosterScope = 'organization' | 'team'

type PagedRoster<T, TPermissions> = { items: T[]; permissions: TPermissions }

const pathFor = (scope: MemberRosterScope, resource: 'members' | 'invitations') =>
  scope === 'organization'
    ? `/api/organization/${resource === 'members' ? 'members' : 'member-invitations'}`
    : `/api/team/${resource}`

const keyFor = (scope: MemberRosterScope, resource: 'members' | 'invitations') =>
  scope === 'organization'
    ? organizationKeys.memberRoster(resource)
    : teamKeys.memberRoster(resource)

export const useMemberRoster = (
  scope: MemberRosterScope,
  status: 'ACTIVE' | 'DEACTIVATED',
  enabled = true,
) =>
  usePagedList<TeamMemberRecord, PagedRoster<TeamMemberRecord, MemberRosterPermissions>>({
    enabled,
    items: (response) => response.items,
    params: { status },
    path: pathFor(scope, 'members'),
    queryKey: keyFor(scope, 'members'),
  })

type InvitationPermissions = Pick<MemberRosterPermissions, 'addMember'> & {
  viewPendingInvitations: boolean
}

export const useMemberInvitations = (scope: MemberRosterScope, enabled = true) =>
  usePagedList<TeamInvitationRecord, PagedRoster<TeamInvitationRecord, InvitationPermissions>>({
    enabled,
    items: (response) => response.items,
    path: pathFor(scope, 'invitations'),
    queryKey: keyFor(scope, 'invitations'),
  })

export const useInvitationTargets = (enabled: boolean) =>
  usePagedList<MemberInvitationTarget, PagedRoster<MemberInvitationTarget, { createInvitation: boolean }>>({
    enabled,
    items: (response) => response.items,
    paramPrefix: 'invite-',
    path: '/api/organization/member-invitation-targets',
    queryKey: organizationKeys.invitationTargets,
  })

type CandidateEnvelope = PagedRoster<TeamMemberCandidate, {
  addMember: boolean
  searchMemberCandidates: boolean
}>

export const useTeamMemberCandidates = (query: string, enabled: boolean) => {
  const api = useApiClient()
  const search = query.trim()
  return useQuery({
    enabled: enabled && search.length > 0,
    queryFn: () => api.getPage<CandidateEnvelope>(`/api/team/members/candidates?q=${encodeURIComponent(search)}&limit=20`),
    queryKey: teamKeys.memberCandidates(search),
  })
}

export const useMemberWorkspaceAccess = (uoaSub: string | null, enabled: boolean) => {
  const api = useApiClient()
  return useQuery({
    enabled: enabled && uoaSub !== null,
    queryFn: () => api.getPage<MemberWorkspaceAccessResponse>(
      `/api/organization/members/${encodeURIComponent(uoaSub!)}/workspaces`,
    ),
    queryKey: organizationKeys.memberWorkspaces(uoaSub ?? undefined),
  })
}

const invalidateRosters = (queryClient: ReturnType<typeof useQueryClient>) => {
  void queryClient.invalidateQueries({ queryKey: organizationKeys.members })
  void queryClient.invalidateQueries({ queryKey: teamKeys.members })
  void queryClient.invalidateQueries({ queryKey: teamKeys.invitations })
}

export const useInviteMember = (scope: MemberRosterScope) => {
  const api = useApiClient()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: CreateMemberInvitationRequest & { teamId?: string }) =>
      api.post(
        scope === 'organization' ? '/api/organization/member-invitations' : '/api/team/invitations',
        input,
      ),
    onSuccess: () => invalidateRosters(queryClient),
  })
}

export const useAddTeamMember = () => {
  const api = useApiClient()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: { uoaSub: string }) => api.post('/api/team/members', input),
    onSuccess: () => invalidateRosters(queryClient),
  })
}

export const useUpdateTeamMemberRole = () => {
  const api = useApiClient()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: { role: string; uoaSub: string }) =>
      api.put(`/api/team/members/${encodeURIComponent(input.uoaSub)}/role`, { role: input.role }),
    onSuccess: () => invalidateRosters(queryClient),
  })
}

export const useUpdateMemberWorkspaceAccess = () => {
  const api = useApiClient()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: { uoaSub: string; workspaceIds: string[] }) =>
      api.put(`/api/organization/members/${encodeURIComponent(input.uoaSub)}/workspaces`, {
        workspaceIds: input.workspaceIds,
      }),
    onSuccess: () => invalidateRosters(queryClient),
  })
}

export const useRevokeMemberInvitation = (scope: MemberRosterScope) => {
  const api = useApiClient()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: { inviteId: string; teamId?: string }) =>
      scope === 'team'
        ? api.post(`/api/team/invitations/${encodeURIComponent(input.inviteId)}/revoke`, {})
        : api.post(`/api/organization/member-invitations/${encodeURIComponent(input.inviteId)}/revoke`, {
            teamId: input.teamId,
          }),
    onSuccess: () => invalidateRosters(queryClient),
  })
}
