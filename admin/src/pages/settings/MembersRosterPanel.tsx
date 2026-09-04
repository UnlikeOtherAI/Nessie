import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import type { TeamInvitationRecord, TeamMemberRecord } from '@nessie/schemas'

import { UserAvatar } from '../../components/primitives/UserAvatar'
import { TabBar } from '../../components/primitives/TabBar'
import { DataTable, type DataTableColumn } from '../../components/shared/DataTable'
import { Dialog } from '../../components/shared/Dialog'
import { EmptyState } from '../../components/shared/EmptyState'
import { FormActions, FormError } from '../../components/shared/FormActions'
import { PaginationFooter } from '../../components/shared/PaginationFooter'
import { QueryState } from '../../components/shared/QueryState'
import {
  useMemberInvitations,
  useMemberRoster,
  useRevokeMemberInvitation,
  type MemberRosterScope,
} from '../../facades/users/member-roster'
import { useAuthSession } from '../../providers/AuthSessionProvider'
import { SettingsPanel } from './settings-shared'
import { MemberInvitationDialog } from './MemberInvitationDialog'
import { MemberDetailsDialog } from './MemberDetailsDialog'
import { AutomaticMembershipRulesPanel } from './AutomaticMembershipRulesPanel'

type RosterTab = 'active' | 'pending' | 'deactivated' | 'automatic'

const rosterTabs = [
  { label: 'Active users', value: 'active' },
  { label: 'Pending invitations', value: 'pending' },
  { label: 'Deactivated users', value: 'deactivated' },
  { label: 'Automatic logins', value: 'automatic' },
] as const

const dateLabel = (value: string | undefined) => {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.valueOf()) ? '—' : date.toLocaleDateString()
}

const memberColumns = (
  scope: MemberRosterScope,
  token: string | null,
): DataTableColumn<TeamMemberRecord>[] => [
  {
    header: 'User',
    key: 'user',
    render: (member: TeamMemberRecord) => (
      <div className="flex min-w-0 items-center gap-3">
        <UserAvatar
          displayName={member.displayName ?? member.email ?? 'Member'}
          size={32}
          token={token}
          avatarUrl={member.avatarImageUrl}
          uoaSub={scope === 'team' ? member.uoaSub : undefined}
          userId={member.userId}
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
  const [selectedMember, setSelectedMember] = useState<TeamMemberRecord | null>(null)
  const [selectedInvitation, setSelectedInvitation] = useState<TeamInvitationRecord | null>(null)
  const [revokeError, setRevokeError] = useState<string | null>(null)
  const requestedTab = searchParams.get('membersTab')
  const tab: RosterTab = requestedTab === 'pending' || requestedTab === 'deactivated' || requestedTab === 'automatic'
    ? requestedTab
    : 'active'
  const roster = useMemberRoster(
    scope,
    tab === 'deactivated' ? 'DEACTIVATED' : 'ACTIVE',
    tab !== 'pending' && tab !== 'automatic',
  )
  const invitations = useMemberInvitations(scope, tab === 'pending')
  const revokeInvitation = useRevokeMemberInvitation(scope)
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
  const closeInvitation = () => {
    setSelectedInvitation(null)
    setRevokeError(null)
  }
  const revokeSelectedInvitation = async () => {
    if (!selectedInvitation) return
    if (scope === 'organization' && !selectedInvitation.team?.id) {
      setRevokeError('This invitation no longer has a workspace target.')
      return
    }
    setRevokeError(null)
    try {
      await revokeInvitation.mutateAsync({
        inviteId: selectedInvitation.inviteId,
        ...(scope === 'organization' ? { teamId: selectedInvitation.team?.id } : {}),
      })
      closeInvitation()
    } catch (error) {
      setRevokeError(error instanceof Error ? error.message : 'Unable to cancel this invitation.')
    }
  }

  return (
    <SettingsPanel
      actions={canInvite && tab !== 'automatic' ? [{
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
          {tab === 'automatic' ? <AutomaticMembershipRulesPanel scope={scope} /> : <QueryState
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
                onRowClick={(invite) => {
                  setRevokeError(null)
                  setSelectedInvitation(invite)
                }}
                rowActionLabel={(invite) => `Open invitation for ${invite.name ?? invite.email ?? 'member'}`}
                rowKey={(invite) => invite.inviteId}
                rows={invitationsRows}
              />
            ) : (
              <DataTable
                columns={memberColumns(scope, token)}
                empty={<EmptyState title={tab === 'active' ? 'No active users' : 'No deactivated users'}>{tab === 'active' ? 'Invite someone to add the first member.' : 'No members are deactivated.'}</EmptyState>}
                expandable={false}
                label={tab === 'active' ? 'Active users' : 'Deactivated users'}
                onRowClick={setSelectedMember}
                rowActionLabel={(member) => `Open ${member.displayName ?? member.email ?? 'member'}`}
                rowKey={(member) => member.uoaSub}
                rows={members}
              />
            )}
          </QueryState>}
          {tab !== 'automatic' ? <PaginationFooter
            canNext={current.canNext}
            canPrevious={current.canPrevious}
            className="mt-4"
            hideWhenSinglePage
            label={current.label}
            onPageChange={current.onPageChange}
            onPageSizeChange={current.onPageSizeChange}
            page={current.page}
            pageCount={current.pageCount}
            pageSize={current.pageSize}
          /> : null}
        </section>
      </div>
      <MemberInvitationDialog onClose={() => setInviteOpen(false)} open={inviteOpen} scope={scope} />
      <MemberDetailsDialog
        member={selectedMember}
        onClose={() => setSelectedMember(null)}
        open={selectedMember !== null}
        permissions={roster.query.data?.data.permissions}
        scope={scope}
      />
      <Dialog
        description="This cannot be undone. You can send a new invitation later."
        dismissDisabled={revokeInvitation.isPending}
        onClose={closeInvitation}
        open={selectedInvitation !== null}
        title="Cancel invitation"
      >
        <div className="space-y-4 p-4">
          <p className="text-sm text-[color:var(--tx)]">
            Cancel the invitation for {selectedInvitation?.name ?? selectedInvitation?.email ?? 'this person'}?
          </p>
          <FormError>{revokeError}</FormError>
          <FormActions destructive={(
            <button
              className="admin-button admin-button-danger"
              disabled={revokeInvitation.isPending}
              onClick={() => void revokeSelectedInvitation()}
              type="button"
            >
              {revokeInvitation.isPending ? 'Cancelling…' : 'Cancel invitation'}
            </button>
          )}
          >
            <button
              className="admin-button admin-button-secondary"
              disabled={revokeInvitation.isPending}
              onClick={closeInvitation}
              type="button"
            >
              Keep invitation
            </button>
          </FormActions>
        </div>
      </Dialog>
    </SettingsPanel>
  )
}
