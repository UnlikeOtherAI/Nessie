import { ApiClientError, ApiClientProvider, type ApiClient } from '@nessie/client-core'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import type {
  AutomaticMembershipResponse,
  TeamMemberRecord,
  TeamInvitationRecord,
  UserAlertRecord,
} from '@nessie/schemas'

import { MembersRosterPanel } from '../../src/components/features/settings/MembersRosterPanel'
import { AlertsBell } from '../../src/layouts/admin-shell/AlertsBell'
import { AuthSessionProvider } from '../../src/providers/AuthSessionProvider'
import { FocusModeProvider } from '../../src/providers/FocusModeProvider'
import '../../src/styles.css'

const params = new URLSearchParams(location.search)
const scope = params.get('scope') === 'organization' ? 'organization' : 'team'
const readOnly = params.has('readOnly')
const fail = params.get('fail')
const noPermissions = params.has('noPermissions')
const pendingApproval = params.has('pendingApproval')
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
const permissions = {
  addMember: !readOnly && !noPermissions, changeMemberRole: !readOnly && !noPermissions,
  removeMember: !readOnly && !noPermissions, deactivateMember: !readOnly && !noPermissions,
  reactivateMember: !readOnly && !noPermissions, viewMemberEmail: true,
  teamRoleOptions: ['admin', 'member'], orgRoleOptions: ['admin', 'member'],
}
let members: TeamMemberRecord[] = [
  { uoaSub: 'subject-jakub', displayName: 'Jakub Rafaj', email: 'jakub@example.test',
    teamRole: 'member', orgRole: 'member', status: 'ACTIVE' },
]
let invitations: TeamInvitationRecord[] = [
  { inviteId: 'invite-existing', email: 'pending@example.test', status: 'pending',
    team: { id: 'team-external', name: 'Design' },
    ...(pendingApproval ? { approvalStatus: 'pending' } : {}) },
]
let access = true
const calls: { method: string; path: string; body?: unknown }[] = []
const failedRuleId = '10000000-0000-4000-8000-000000000015'
const automaticMembership: AutomaticMembershipResponse = {
  domains: [{
    challengeExpiresAt: '2026-09-13T00:00:00.000Z',
    domain: 'example.test',
    id: '10000000-0000-4000-8000-000000000016',
    recordName: '_nessie-domain-verification.example.test',
    rules: [{
      createdScope: 'organization', enabled: true, grantedCount: 4,
      health: 'needs_reauthorization', healthReason: 'The original grant expired.',
      id: failedRuleId, manageable: true, teamId: '10000000-0000-4000-8000-000000000017',
      teamName: 'Design',
    }],
    status: 'active',
  }],
  permissions: { manageDomains: true, manageReconciliation: true, manageRules: true },
  provisioningEnabled: true,
  teamOptions: [{ id: '10000000-0000-4000-8000-000000000017', name: 'Design' }],
}
let alerts: UserAlertRecord[] = [{
  actorAgentId: null, actorDisplayName: null, actorUserId: null,
  automaticMembershipRuleId: failedRuleId, automaticMembershipRuleTeamName: 'Design',
  boardSourceId: null, callId: null, channelId: null, channelLabel: null,
  createdAt: '2026-09-12T10:00:00.000Z', id: '10000000-0000-4000-8000-000000000018',
  kind: 'automatic_membership_health', knowledgePageId: null, messageId: null,
  metadata: null, projectId: null, readAt: null, rootMessageId: null, taskId: null,
  threadId: null, triggerId: null,
}]
Object.assign(window, {
  memberManagementCalls: calls,
  refetchMemberManagementQueries: () => queryClient.refetchQueries(),
})
const page = (items: unknown[], grants: unknown) => ({
  data: { items, permissions: grants },
  meta: { hasMore: false, limit: 25, total: items.length },
})
const getPage = async (path: string) => {
  calls.push({ method: 'GET', path })
  const url = new URL(path, location.origin)
  if (url.pathname === '/api/alerts') return alerts
  if (url.pathname === '/api/alerts/summary') {
    return {
      assignedWork: { projects: {}, total: 0 },
      knowledge: { projects: {}, total: 0 },
      unreadCount: alerts.filter((alert) => alert.readAt === null).length,
    }
  }
  if (url.pathname.endsWith('/automatic-membership')) return automaticMembership
  if (path.includes('/candidates')) {
    if (fail === 'search') throw new Error('Directory unavailable')
    return page([{ uoaSub: 'subject-ondrej', displayName: 'Ondřej Novák' }],
      { addMember: !readOnly && !noPermissions, searchMemberCandidates: true })
  }
  if (path.includes('/member-invitation-targets')) return page([{ id: 'team-external', name: 'Design' }],
    { createInvitation: !readOnly && !noPermissions })
  if (url.pathname.endsWith('/teams')) {
    if (fail === 'access') throw new Error('Directory unavailable')
    return page([{ id: 'team-external', name: 'Design', hasAccess: access }], { changeTeamAccess: !readOnly && !noPermissions })
  }
  if (path.includes('invitations')) return page(invitations, { addMember: !readOnly && !noPermissions, viewPendingInvitations: true })
  if (url.pathname.endsWith('/members')) return page(members.filter((member) => member.status === url.searchParams.get('status')), permissions)
  throw new Error(`Unexpected GET ${path}`)
}
const mutate = (method: string) => async (path: string, body?: Record<string, unknown>) => {
  calls.push({ method, path, body })
  if (params.has('slow')) await new Promise((done) => window.setTimeout(done, 150))
  if (fail === 'role' && path.endsWith('/role')) {
    throw new ApiClientError('Your permission to change this role has changed. Reload members and try again.', 'FORBIDDEN', 403)
  }
  if (fail === 'invite' && (path.endsWith('/invitations') || path.endsWith('/member-invitations'))) {
    throw new ApiClientError('Your permission to send invitations has changed. Reload members and try again.', 'FORBIDDEN', 403)
  }
  if (path.endsWith('/role')) members = members.map((member) => path.includes('/organization/members/')
    ? { ...member, orgRole: String(body?.role) }
    : { ...member, teamRole: String(body?.role) })
  else if (path.endsWith('/teams')) access = (body?.teamIds as string[]).includes('team-external')
  else if (path.endsWith('/deactivate')) members = members.map((member) => ({ ...member, status: 'DEACTIVATED' }))
  else if (path.endsWith('/reactivate')) members = members.map((member) => ({ ...member, status: 'ACTIVE' }))
  else if (method === 'DELETE') members = []
  else if (path.endsWith('/revoke')) invitations = []
  else if (path.endsWith('/invitations') || path.endsWith('/member-invitations')) {
    const email = String(body?.email)
    // UOA, not this fixture or Nessie, owns the one-actionable-invitation rule
    // for the exact target team and normalized email. A repeated form submit
    // sends another request but keeps one pending row, modelling UOA's resend.
    const hasPendingInvitation = invitations.some((invitation) =>
      invitation.email?.trim().toLowerCase() === email.trim().toLowerCase()
      && invitation.team?.id === 'team-external')
    if (!hasPendingInvitation) invitations.push({
      inviteId: 'invite-new', email, name: body?.name as string | undefined,
      status: 'pending', team: { id: 'team-external', name: 'Design' },
    })
  }
  else if (path.endsWith('/members')) members.push({ uoaSub: 'subject-ondrej', displayName: 'Ondřej Novák', status: 'ACTIVE' })
  else if (path === '/api/alerts/read') alerts = alerts.map((alert) => (
    body?.ids?.includes(alert.id) || body?.all === true
      ? { ...alert, readAt: '2026-09-12T10:01:00.000Z' }
      : alert
  ))
  return { ok: true }
}
const client = { getPage, get: getPage, post: mutate('POST'), put: mutate('PUT'),
  delete: mutate('DELETE'), patch: mutate('PATCH') } as unknown as ApiClient
const root = document.querySelector('#root')
if (!(root instanceof HTMLElement)) throw new Error('Fixture root missing')
document.documentElement.dataset.theme = 'sandstone'
createRoot(root).render(
  <QueryClientProvider client={queryClient}>
    <AuthSessionProvider><ApiClientProvider client={client}><FocusModeProvider><BrowserRouter>
      <main className="h-screen bg-[color:var(--main)] text-[color:var(--tx)]">
        <div className="flex justify-end p-3"><AlertsBell /></div>
        <MembersRosterPanel scope={scope} />
      </main>
    </BrowserRouter></FocusModeProvider></ApiClientProvider></AuthSessionProvider>
  </QueryClientProvider>,
)
