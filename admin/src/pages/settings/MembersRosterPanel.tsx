import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import type { TeamInvitationRecord, TeamMemberRecord } from '@nessie/schemas'

import { UserAvatar } from '../../components/primitives/UserAvatar'
import { TabBar } from '../../components/primitives/TabBar'
import { DataTable, type DataTableColumn } from '../../components/shared/DataTable'
import { EmptyState } from '../../components/shared/EmptyState'
import { PaginationFooter } from '../../components/shared/PaginationFooter'
import { QueryState } from '../../components/shared/QueryState'
import {
  useMemberInvitations,
  useMemberRoster,
  type MemberRosterScope,
} from '../../facades/users/member-roster'
import { useAuthSession } from '../../providers/AuthSessionProvider'
import { SettingsPanel } from './settings-shared'
import { MemberInvitationDialog } from './MemberInvitationDialog'

type RosterTab = 'active' | 'pending' | 'deactivated'

const rosterTabs = [
  { label: 'Active users', value: 'active' },
  { label: 'Pending invitations', value: 'pending' },
  { label: 'Deactivated users', value: 'deactivated' },
] as const

const dateLabel = (value: string | undefined) => {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.valueOf()) ? '—' : date.toLocaleDateString()
}

const memberColumns = (
  scope: MemberRosterScope,
  token: string | null,
) : DataTableColumn<TeamMemberRecord>[] => [
  {
    header: 'User',
    key: 'user',
    render: (member: TeamMemberRecord) => (
      <div className="flex min-w-0 items-center gap-3">
        <UserAvatar
          displayName={member.displayName ?? member.email ?? 'Member'}
          size={32}
          token={token}
          {...(member.userId
            ? { userId: member.userId }
            : scope === 'team' ? { uoaSub: member.uoaSub } : {})}
        />
        <span className="min-w-0">
          <span className="block truncate font-medium">{member.displayName ?? 'Unnamed member'}</span>
          {member.email ? <span className="block truncate text-xs text-[color:var(--tx3)]">{member.email}</span> : null}
        </span>
      </div>
    ),
  },
  {
    header: 'Role',
    key: 'role',
    render: (member: TeamMemberRecord) => member[scope === 'organization' ? 'orgRole' : 'teamRole'] ?? '—',
    secondary: true,
  },
]

const invitationColumns = (scope: MemberRosterScope): DataTableColumn<TeamInvitationRecord>[] => [
  {
    header: 'Invitee',
    key: 'invitee',
    render: (invite: TeamInvitationRecord) => (
      <span className="min-w-0">
        <span className="block truncate font-medium">{invite.name ?? invite.email ?? 'Invitation'}</span>
        {invite.name && invite.email ? <span className="block truncate text-xs text-[color:var(--tx3)]">{invite.email}</span> : null}
      </span>
    ),
  },
  ...(scope === 'organization'
    ? [{
        header: 'Workspace',
        key: 'team',
        render: (invite: TeamInvitationRecord) => invite.team?.name ?? '—',
        secondary: true,
      }]
    : []),
  {
    header: 'Expires',
    key: 'expires',
    render: (invite: TeamInvitationRecord) => dateLabel(invite.expiresAt),
    secondary: true,
  },
]

/** The single Members page used at organization and team scope. */
export const MembersRosterPanel = ({ scope }: { scope: MemberRosterScope }) => {
  const { token } = useAuthSession()
  const [searchParams, setSearchParams] = useSearchParams()
  const [inviteOpen, setInviteOpen] = useState(false)
  const requestedTab = searchParams.get('membersTab')
  const tab: RosterTab = requestedTab === 'pending' || requestedTab === 'deactivated'
    ? requestedTab
    : 'active'
  const roster = useMemberRoster(
    scope,
    tab === 'deactivated' ? 'DEACTIVATED' : 'ACTIVE',
    tab !== 'pending',
  )
  const invitations = useMemberInvitations(scope, tab === 'pending')
  const current = tab === 'pending' ? invitations : roster
  const permissions = current.query.data?.data.permissions
  const canInvite = permissions?.addMember === true

  const setTab = (next: RosterTab) => {
    setSearchParams((currentParams) => {
      const updated = new URLSearchParams(currentParams)
      updated.delete('cursor')
      updated.delete('direction')
      updated.delete('page')
      updated.set('membersTab', next)
      return updated
    }, { replace: true })
  }

  const members = roster.items
  const invitationsRows = invitations.items
  const tabPanelId = `members-${scope}-tabpanel-${tab}`

  return (
    <SettingsPanel
      actions={canInvite ? [{
        id: 'invite-member',
        label: 'Send invitation',
        onSelect: () => setInviteOpen(true),
        primary: true,
        priority: 1,
      }] : undefined}
      eyebrow={scope === 'organization' ? 'Organization' : 'Team'}
      title="Members"
    >
      <div className="space-y-5">
        <TabBar
          ariaLabel="Member status"
          idPrefix={`members-${scope}`}
          items={rosterTabs}
          onChange={setTab}
          value={tab}
        />
        <section aria-labelledby={`members-${scope}-tab-${tab}`} id={tabPanelId} role="tabpanel">
          <QueryState
            errorLabel="Members could not be loaded."
            loadingLabel="Loading members…"
            query={current.query}
          >
            {() => tab === 'pending' ? (
              <DataTable
                columns={invitationColumns(scope)}
                empty={<EmptyState title="No pending invitations">No invitations are awaiting a response.</EmptyState>}
                expandable={false}
                label="Pending invitations"
                rowKey={(invite) => invite.inviteId}
                rows={invitationsRows}
              />
            ) : (
              <DataTable
                columns={memberColumns(scope, token)}
                empty={<EmptyState title={tab === 'active' ? 'No active users' : 'No deactivated users'}>{tab === 'active' ? 'Invite someone to add the first member.' : 'No members are deactivated.'}</EmptyState>}
                expandable={false}
                label={tab === 'active' ? 'Active users' : 'Deactivated users'}
                rowKey={(member) => member.uoaSub}
                rows={members}
              />
            )}
          </QueryState>
          <PaginationFooter
            canNext={current.canNext}
            canPrevious={current.canPrevious}
            className="mt-4"
            hideWhenSinglePage
            label={current.label}
            onPageChange={current.onPageChange}
            page={current.page}
          />
        </section>
      </div>
      <MemberInvitationDialog onClose={() => setInviteOpen(false)} open={inviteOpen} scope={scope} />
    </SettingsPanel>
  )
}
