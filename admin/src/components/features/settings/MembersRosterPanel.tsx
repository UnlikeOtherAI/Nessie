import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import type { TeamInvitationRecord, TeamMemberRecord } from '@nessie/schemas'

import { UserAvatar } from '../../shared/UserAvatar'
import { memberDisplayName } from '../../../lib/member-display-name'
import { TabBar } from '../../primitives/TabBar'
import { EmptyState } from '../../shared/EmptyState'
import { PaginationFooter } from '../../shared/PaginationFooter'
import { QueryState } from '../../shared/QueryState'
import { Row } from '../../shared/RowList'
import {
  useMemberInvitations,
  useMemberRoster,
  type MemberRosterScope,
} from '../../../facades/users/member-roster'
import {
  AutomaticMembershipRulesPanel,
} from './AutomaticMembershipRulesPanel'
import { useAuthSession } from '../../../providers/AuthSessionProvider'
import { useTabParam } from '../../../navigation/useTabParam'
import { SettingsPanel, type SettingsTabHostProps } from '../../shared/SettingsPanel'
import { MemberInvitationDialog } from './MemberInvitationDialog'
import { MemberDetailsDialog } from './MemberDetailsDialog'
import { MemberInvitationDetailsDialog } from './MemberInvitationDetailsDialog'

type RosterTab = 'active' | 'pending' | 'deactivated' | 'automatic'

// Every value the strip can hold, regardless of whether `canSeeAutomatic`
// currently renders that pill — `?tab=automatic` must keep validating
// while the permissions read that would confirm it is still in flight (see
// `canSeeAutomatic` below), the same way the ladder this replaced accepted it
// unconditionally.
const ROSTER_TAB_VALUES: readonly RosterTab[] = ['active', 'pending', 'deactivated', 'automatic']

// A tab's own list position: its cursor and page mean nothing on another tab.
const ROSTER_TAB_OWNED_PARAMS = ['cursor', 'direction', 'page'] as const

const ROSTER_TABS = [
  { compactLabel: 'Active', label: 'Active members', value: 'active' },
  { compactLabel: 'Pending', label: 'Pending invitations', value: 'pending' },
  { compactLabel: 'Inactive', label: 'Deactivated members', value: 'deactivated' },
] as const

const AUTOMATIC_TAB = {
  label: 'Automatic logins', value: 'automatic', compactLabel: 'Access',
} as const

const dateLabel = (value: string | undefined) => {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.valueOf()) ? '—' : date.toLocaleDateString()
}

const disclosure = <span aria-hidden="true" className="text-xl leading-none text-[color:var(--tx3)]">›</span>

const memberSubtitle = (member: TeamMemberRecord, scope: MemberRosterScope) => {
  const role = member[scope === 'organization' ? 'orgRole' : 'teamRole']
  return [member.email, role].filter(Boolean).join(' · ')
}

const invitationSubtitle = (invite: TeamInvitationRecord, scope: MemberRosterScope) => [
  invite.email,
  scope === 'organization' ? invite.team?.name : undefined,
  invite.expiresAt ? `Expires ${dateLabel(invite.expiresAt)}` : undefined,
].filter(Boolean).join(' · ')

const rosterTitle = (tab: Exclude<RosterTab, 'automatic'>) => tab === 'active'
  ? 'Active members'
  : tab === 'pending' ? 'Pending invitations' : 'Deactivated members'

const rosterSubtitle = (tab: Exclude<RosterTab, 'automatic'>, scope: MemberRosterScope) => {
  if (tab === 'active') return scope === 'organization' ? 'People in your organisation.' : 'People in this team.'
  if (tab === 'pending') return 'People you’ve invited who haven’t joined yet.'
  return 'People whose access to your organisation is paused.'
}

/**
 * The one roster, at organisation and team scope: People, behind its scope
 * switch. The host (`PeoplePage`) owns the switch and hands it down with the
 * screen's name, so there is still one header.
 */
export const MembersRosterPanel = ({
  host,
  scope,
}: {
  host?: SettingsTabHostProps
  scope: MemberRosterScope
}) => {
  const { me, token } = useAuthSession()
  const [searchParams] = useSearchParams()
  const [inviteOpen, setInviteOpen] = useState(false)
  const [selectedMember, setSelectedMember] = useState<TeamMemberRecord | null>(null)
  const [selectedInvitation, setSelectedInvitation] = useState<TeamInvitationRecord | null>(null)
  // A different tab is a different list, so its cursor means nothing there —
  // cleared in the same replace rather than left to point at the wrong page.
  const [tab, setTab] = useTabParam('tab', ROSTER_TAB_VALUES, 'active', {
    clears: ROSTER_TAB_OWNED_PARAMS,
  })

  // The roster read also carries UOA's live verdict on what this person may do,
  // which is what decides whether the Automatic logins tab exists at all — so
  // it runs on that tab too, cheaply. What must NOT happen is the rules panel
  // being gated on it: `current` is null there, so no `QueryState` wraps the
  // panel and no pagination footer sits under it.
  const roster = useMemberRoster(
    scope,
    tab === 'deactivated' ? 'DEACTIVATED' : 'ACTIVE',
    tab !== 'pending',
  )
  const invitations = useMemberInvitations(scope, tab === 'pending')
  const current = tab === 'automatic' ? null : tab === 'pending' ? invitations : roster
  const permissions = (current ?? roster).query.data?.data.permissions
  const canInvite = permissions?.addMember === true && tab !== 'automatic'

  // The tab exists only where it can do something: the instance flag is on and
  // this person may administer members. A tab whose every request 404s or 403s
  // is a doorway to nothing. It also stays visible once selected, so a slow
  // permissions read cannot make it vanish under the person using it.
  const canSeeAutomatic = me?.features?.automaticMembership === true
    && (permissions?.addMember === true || tab === 'automatic')
  const tabs = canSeeAutomatic ? [...ROSTER_TABS, AUTOMATIC_TAB] : ROSTER_TABS

  const members = roster.items
  const invitationsRows = invitations.items
  const tabPanelId = `members-${scope}-tabpanel-${tab}`
  const visibleTab = tab === 'automatic' ? null : tab
  return (
    <SettingsPanel
      actions={canInvite ? [{
        id: 'invite-member',
        label: 'Invite people',
        onSelect: () => setInviteOpen(true),
        primary: true,
        priority: 1,
      }] : undefined}
      eyebrow={scope === 'organization' ? 'Organisation' : 'Team'}
      host={host}
      title="People"
    >
      <div className="mx-auto grid w-full max-w-[1040px] gap-8 py-4">
        <TabBar
          ariaLabel="Member status"
          collapse="never"
          fullWidth
          idPrefix={`members-${scope}`}
          items={tabs}
          onChange={setTab}
          touchTarget
          value={tab}
        />
        <section aria-labelledby={`members-${scope}-tab-${tab}`} id={tabPanelId} role="tabpanel">
          {tab === 'automatic' ? (
            <AutomaticMembershipRulesPanel
              highlightedRuleId={searchParams.get('automaticMembershipRule')}
              scope={scope}
            />
          ) : (
            <>
          <div className="mb-3.5 flex items-end justify-between gap-4">
            <div>
              <h2 className="text-[17px] font-semibold text-[color:var(--tx)]">
                {visibleTab ? rosterTitle(visibleTab) : null}
              </h2>
              <p className="mt-1 text-sm text-[color:var(--tx2)]">
                {visibleTab ? rosterSubtitle(visibleTab, scope) : null}
              </p>
            </div>
            {current?.total !== undefined ? (
              <span className="shrink-0 text-sm tabular-nums text-[color:var(--tx3)]">
                {current.total} total
              </span>
            ) : null}
          </div>
          <QueryState
            errorLabel={tab === 'pending' ? 'Invitations could not be loaded.' : 'Members could not be loaded.'}
            loadingLabel={tab === 'pending' ? 'Loading invitations…' : 'Loading members…'}
            query={(current ?? roster).query}
          >
            {() => tab === 'pending' ? (
              invitationsRows.length === 0 ? (
                <EmptyState title="No pending invitations">Invitations show up here until they’re accepted.</EmptyState>
              ) : (
                <ul aria-label="Pending invitations" className="divide-y divide-[color:var(--sep)] border-y border-[color:var(--sep)]">
                  {invitationsRows.map((invite) => {
                    const name = memberDisplayName(invite.name, invite.email) ?? 'Invitation'
                    return (
                      <Row
                        ariaLabel={`Open invitation for ${invite.name ?? invite.email ?? 'member'}`}
                        key={invite.inviteId}
                        onClick={() => setSelectedInvitation(invite)}
                        subtitle={invitationSubtitle(invite, scope)}
                        title={<span className="font-medium">{name}</span>}
                        trailing={disclosure}
                      />
                    )
                  })}
                </ul>
              )
            ) : (
              members.length === 0 ? (
                <EmptyState title={tab === 'active' ? 'No active members' : 'No deactivated members'}>
                  {tab === 'active' ? 'Invite someone to add the first member.' : 'Members you deactivate show up here.'}
                </EmptyState>
              ) : (
                <ul aria-label={tab === 'active' ? 'Active members' : 'Deactivated members'}
                  className="divide-y divide-[color:var(--sep)] border-y border-[color:var(--sep)]">
                  {members.map((member) => {
                    const name = memberDisplayName(member.displayName, member.email) ?? 'Unnamed member'
                    return (
                      <Row
                        ariaLabel={`Open ${name}`}
                        key={member.uoaSub}
                        leading={(
                          <UserAvatar
                            avatarUrl={member.avatarImageUrl}
                            displayName={name}
                            size={40}
                            token={token}
                            uoaSub={scope === 'team' ? member.uoaSub : undefined}
                            userId={member.userId}
                          />
                        )}
                        onClick={() => setSelectedMember(member)}
                        subtitle={memberSubtitle(member, scope)}
                        title={<span className="font-medium">{name}</span>}
                        trailing={disclosure}
                      />
                    )
                  })}
                </ul>
              )
            )}
          </QueryState>
          {current ? (
            <PaginationFooter
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
            />
          ) : null}
            </>
          )}
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
      <MemberInvitationDetailsDialog
        canManage={invitations.query.data?.data.permissions.addMember === true}
        invitation={selectedInvitation}
        onClose={() => setSelectedInvitation(null)}
        scope={scope}
      />
    </SettingsPanel>
  )
}
