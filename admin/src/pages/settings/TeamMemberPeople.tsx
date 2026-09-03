import { useState } from 'react'
import type { TeamMemberRecord } from '@nessie/schemas'

import { UserAvatar } from '../../components/primitives/UserAvatar'
import {
  PausedPrivateAgentsBucket,
  PersonAgents,
  UnassignedAgents,
} from '../../components/features/members/PersonAgents'
import type { PeopleAgentsTree } from '../../components/features/members/people-agents-tree'
import type { AgentRecord } from '../../lib/api-client'
import { useAuthSession } from '../../providers/AuthSessionProvider'
import {
  useRemoveTeamMember,
  useSetTeamMemberActivation,
  useUpdateTeamMemberRole,
} from '../../facades/users/team-members'
import { Pill } from '../../components/primitives/Pill'
import { Card } from '../../components/shared/Card'
import { FormError } from '../../components/shared/FormActions'
import { Select } from '../../components/shared/FormControls'

const errorMessage = (caught: unknown, fallback: string): string =>
  caught instanceof Error ? caught.message : fallback

const memberLabel = (member: TeamMemberRecord): string =>
  member.displayName ?? member.email ?? member.uoaSub

// UOA's own team-role vocabulary. Ownership transfer is a separate UOA
// operation, so "owner" is shown but never offered as a change.
export const TEAM_TEAM_ROLE_OPTIONS = [
  { value: 'admin', label: 'Admin' },
  { value: 'member', label: 'Member' },
] as const

/** One UOA roster row and the agents its person stewards. */
export const TeamMemberRow = ({
  canManage,
  member,
  ownedAgents,
}: {
  canManage: boolean
  member: TeamMemberRecord
  ownedAgents: AgentRecord[]
}) => {
  const { token } = useAuthSession()
  const updateRole = useUpdateTeamMemberRole()
  const removeMember = useRemoveTeamMember()
  const setActivation = useSetTeamMemberActivation()
  const [error, setError] = useState<string | null>(null)

  const deactivated = member.status === 'DEACTIVATED'
  const busy = updateRole.isPending || removeMember.isPending || setActivation.isPending
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
          {/*
            A roster row is named only by its UOA subject, so the picture comes
            from the subject-keyed relay rather than the user-id one. The same
            `UserAvatar` as everywhere else: it falls back to initials for an
            unlinked person, an unlinked team, or a deployment with no UOA.
          */}
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
        {member.teamRole === 'owner' ? (
          <Pill className="shrink-0" radius="chip" size="sm" tone="outline" uppercase={false}>
            Owner
          </Pill>
        ) : null}
      </div>

      {/*
        This person's agents — their virtual employees. Nested here rather
        than on a separate org-chart page: the roster row is where somebody
        already stands when the question "what does this person run?" arises.
      */}
      <PersonAgents agents={ownedAgents} token={token} />

      {canManage && member.teamRole !== 'owner' ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Select
            aria-label={`Team role for ${label}`}
            disabled={busy}
            onChange={(event) =>
              void act(
                () => updateRole.mutateAsync({ role: event.target.value, uoaSub: member.uoaSub }),
                'Failed to update role',
              )}
            size="compact"
            value={member.teamRole ?? 'member'}
          >
            {TEAM_TEAM_ROLE_OPTIONS.map((option) => (
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
          <button
            className="admin-button admin-button-secondary admin-button-compact"
            disabled={busy}
            onClick={() =>
              void act(
                () => removeMember.mutateAsync({ uoaSub: member.uoaSub }),
                'Failed to remove member',
              )}
            type="button"
          >
            Remove from team
          </button>
        </div>
      ) : null}

      <FormError className="mt-2">{error}</FormError>
    </Card>
  )
}

/** Agents that cannot be nested below a roster row in the current team. */
export const TeamAgentBuckets = ({ tree }: { tree: PeopleAgentsTree }) => {
  const { token } = useAuthSession()
  return (
    <div
      className="mt-5 grid gap-4 border-t border-[color:var(--sep)] pt-4"
      data-testid="team-unassigned-agents"
    >
      <PausedPrivateAgentsBucket count={tree.pausedPrivateAgentCount} />
      {tree.teamOwned.length > 0 ? (
        <UnassignedAgents
          agents={tree.teamOwned}
          emptyLabel="None"
          title="Team-owned agents"
          token={token}
        />
      ) : null}
      {tree.ownedOutsideTeam.length > 0 ? (
        <UnassignedAgents
          agents={tree.ownedOutsideTeam}
          emptyLabel="None"
          title="Owned outside this team"
          token={token}
        />
      ) : null}
    </div>
  )
}
