import { useState } from 'react'
import type { TeamMemberRecord } from '@nessie/schemas'

import { UserAvatar } from '../../components/primitives/UserAvatar'
import { PersonAgents } from '../../components/features/members/PersonAgents'
import { buildPeopleAgentsTree } from '../../components/features/members/people-agents-tree'
import type { AgentRecord } from '../../lib/api-client'
import { useAgents } from '../../facades/agents/queries'
import {
  useOrganizationMembers,
  useSetOrganizationMemberActivation,
  useUpdateOrganizationMemberRole,
} from '../../facades/users/organization-members'
import { useTeamInvitations } from '../../facades/users/team-members'
import { useAuthSession } from '../../providers/AuthSessionProvider'
import { Pill } from '../../components/primitives/Pill'
import { Card } from '../../components/shared/Card'
import { EmptyState } from '../../components/shared/EmptyState'
import { FormError } from '../../components/shared/FormActions'
import { Select } from '../../components/shared/FormControls'
import { Section } from '../../components/shared/PageBody'
import { FeedbackBanner } from './settings-shared'
import { InviteToTeamCard, InvitationRow } from './TeamMembersSection'

const errorMessage = (caught: unknown, fallback: string): string =>
  caught instanceof Error ? caught.message : fallback

const memberLabel = (member: TeamMemberRecord): string =>
  member.displayName ?? member.email ?? member.uoaSub

/*
 * UOA's ORG-role vocabulary (the team roster's is admin/member — see
 * TEAM_TEAM_ROLE_OPTIONS). Ownership transfer is a separate UOA
 * operation, so "owner" is shown but never offered as a change.
 */
const ORG_ROLE_OPTIONS = [
  { value: 'admin', label: 'Admin' },
  { value: 'member', label: 'Member' },
] as const

/** One organisation roster row and the agents its person stewards. */
const OrganizationMemberRow = ({
  canManage,
  member,
  ownedAgents,
}: {
  canManage: boolean
  member: TeamMemberRecord
  ownedAgents: AgentRecord[]
}) => {
  const { token } = useAuthSession()
  const updateRole = useUpdateOrganizationMemberRole()
  const setActivation = useSetOrganizationMemberActivation()
  const [error, setError] = useState<string | null>(null)

  const deactivated = member.status === 'DEACTIVATED'
  const busy = updateRole.isPending || setActivation.isPending
  const label = memberLabel(member)

  const act = async (run: () => Promise<unknown>, fallback: string) => {
    setError(null)
    try {
      await run()
    } catch (caught) {
      setError(errorMessage(caught, fallback))
    }
  }

  return (
    <Card variant="row">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <UserAvatar
            className={deactivated ? 'opacity-60' : undefined}
            displayName={label}
            size={40}
            token={token}
            uoaSub={member.uoaSub}
          />
          <div className="min-w-0">
            <div className="truncate font-semibold text-[color:var(--tx)]">{label}</div>
            {member.email ? (
              <div className="mt-1 truncate text-sm text-[color:var(--tx2)]">{member.email}</div>
            ) : null}
          </div>
        </div>
        {deactivated ? (
          <Pill className="shrink-0" radius="chip" size="sm" tone="warning" uppercase={false}>
            Deactivated
          </Pill>
        ) : null}
        {member.orgRole === 'owner' ? (
          <Pill className="shrink-0" radius="chip" size="sm" tone="outline" uppercase={false}>
            Owner
          </Pill>
        ) : null}
      </div>

      {/* The same nesting the team roster row uses: a person and their agents. */}
      <PersonAgents agents={ownedAgents} token={token} />

      {canManage && member.orgRole !== 'owner' ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Select
            aria-label={`Organisation role for ${label}`}
            disabled={busy}
            onChange={(event) =>
              void act(
                () => updateRole.mutateAsync({ role: event.target.value, uoaSub: member.uoaSub }),
                'Failed to update role',
              )}
            size="compact"
            value={member.orgRole ?? 'member'}
          >
            {ORG_ROLE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
          <button
            className="admin-button admin-button-secondary admin-button-compact"
            disabled={busy}
            onClick={() =>
              void act(
                () =>
                  setActivation.mutateAsync({ deactivated: !deactivated, uoaSub: member.uoaSub }),
                'Failed to update member',
              )}
            type="button"
          >
            {deactivated ? 'Reactivate' : 'Deactivate'}
          </button>
        </div>
      ) : null}

      <FormError className="mt-2">{error}</FormError>
    </Card>
  )
}

/**
 * The organisation-wide roster on an UnlikeOtherAI session: every member of
 * the UOA organisation with their ORG role — the whole org, never silently
 * narrowed to the session's active team. That narrowing was the bug this
 * section fixes: this page previously rendered the team-scoped roster under
 * an "Organization" title (docs/plans/2026-08-31-identity-belonging-audit.md).
 *
 * Invitations stay team-scoped — a UOA `TeamInvite` always lands in one team —
 * so the invite card is the existing team one, with one line naming the
 * team the invitee joins.
 */
export const OrganizationMembersSection = ({
  canManage,
  inviteTeamLabel,
}: {
  canManage: boolean
  /** Name of the session's active team, for the invite card's copy. */
  inviteTeamLabel?: string
}) => {
  const members = useOrganizationMembers()
  // Same tree join as the team roster: line each person up with the agents
  // they steward, without Nessie storing a second copy of UOA's roster.
  const agents = useAgents({ scope: 'all' })

  const memberRows = members.data?.members ?? []
  const tree = buildPeopleAgentsTree(
    memberRows,
    Array.isArray(agents.data) ? agents.data : [],
  )
  const agentsBySub = new Map(
    tree.people.map((person) => [person.member.uoaSub, person.agents]),
  )

  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <Section title="People">
        <div className="grid gap-2" data-testid="organization-member-list">
          {members.isError ? (
            <FeedbackBanner
              feedback={{
                kind: 'error',
                message: 'The UnlikeOtherAI directory could not be reached.',
              }}
            />
          ) : members.isLoading ? (
            <p className="text-sm text-[color:var(--tx3)]">Loading members…</p>
          ) : null}
          {memberRows.map((member) => (
            <OrganizationMemberRow
              canManage={canManage}
              key={member.uoaSub}
              member={member}
              ownedAgents={agentsBySub.get(member.uoaSub) ?? []}
            />
          ))}
          {!members.isLoading && !members.isError && memberRows.length === 0 ? (
            <EmptyState>This organisation has no members in UnlikeOtherAI yet.</EmptyState>
          ) : null}
        </div>
      </Section>

      {canManage ? (
        <div className="grid content-start gap-4">
          <InviteToTeamCard teamLabel={inviteTeamLabel} />
          <PendingInvitations />
        </div>
      ) : null}
    </div>
  )
}

/** Invitations into the session's active team — the only invitations UOA has. */
const PendingInvitations = () => {
  // Invitation emails are PII; the API serves this list to owners and admins
  // only, and this block renders only for those viewers.
  const invitations = useTeamInvitations()
  const invitationRows = (invitations.data?.invitations ?? []).filter(
    (invitation) => (invitation.status ?? 'pending') === 'pending',
  )

  return (
    <Section title="Pending invitations">
      <div className="grid gap-2" data-testid="team-invitation-list">
        {invitations.isLoading ? (
          <p className="text-sm text-[color:var(--tx3)]">Loading invitations…</p>
        ) : null}
        {invitationRows.map((invitation) => (
          <InvitationRow invitation={invitation} key={invitation.inviteId} />
        ))}
        {!invitations.isLoading && invitationRows.length === 0 ? (
          <EmptyState>No invitations are waiting.</EmptyState>
        ) : null}
      </div>
    </Section>
  )
}
