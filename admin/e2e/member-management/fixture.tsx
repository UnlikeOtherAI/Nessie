import { ApiClientError, ApiClientProvider, type ApiClient } from '@nessie/client-core'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import type { TeamMemberRecord, TeamInvitationRecord } from '@nessie/schemas'

import { MembersRosterPanel } from '../../src/components/features/settings/MembersRosterPanel'
import { AuthSessionProvider } from '../../src/providers/AuthSessionProvider'
import '../../src/styles.css'

const params = new URLSearchParams(location.search)
const scope = params.get('scope') === 'organization' ? 'organization' : 'team'
const readOnly = params.has('readOnly')
const fail = params.get('fail')
const noPermissions = params.has('noPermissions')
const pendingApproval = params.has('pendingApproval')
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
Object.assign(window, { memberManagementCalls: calls })
const page = (items: unknown[], grants: unknown) => ({
  data: { items, permissions: grants },
  meta: { hasMore: false, limit: 25, total: items.length },
})
const getPage = async (path: string) => {
  calls.push({ method: 'GET', path })
  const url = new URL(path, location.origin)
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
  else if (path.endsWith('/invitations') || path.endsWith('/member-invitations')) invitations.push({
    inviteId: 'invite-new', email: String(body?.email), name: body?.name as string | undefined,
    status: 'pending', team: { id: 'team-external', name: 'Design' },
  })
  else if (path.endsWith('/members')) members.push({ uoaSub: 'subject-ondrej', displayName: 'Ondřej Novák', status: 'ACTIVE' })
  return { ok: true }
}
const client = { getPage, get: async () => ({}), post: mutate('POST'), put: mutate('PUT'),
  delete: mutate('DELETE'), patch: mutate('PATCH') } as unknown as ApiClient
const root = document.querySelector('#root')
if (!(root instanceof HTMLElement)) throw new Error('Fixture root missing')
document.documentElement.dataset.theme = 'sandstone'
createRoot(root).render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <AuthSessionProvider><ApiClientProvider client={client}><BrowserRouter>
      <main className="h-screen bg-[color:var(--main)] text-[color:var(--tx)]"><MembersRosterPanel scope={scope} /></main>
    </BrowserRouter></ApiClientProvider></AuthSessionProvider>
  </QueryClientProvider>,
)
