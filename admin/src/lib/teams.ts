import type { MeResponse } from '@nessie/schemas'

/**
 * A team is a team — the environment a user enters. `me.context` carries
 * only the active ids, so the human-readable label has to come from the
 * membership tree. Shared by the sidebar switcher and the team settings.
 */
export type Team = {
  organizationId: string
  projectId: string
  teamId: string
  avatarTeamId?: string
  avatarImageUrl?: string
  label: string
  orgName?: string
  active?: boolean
  uoaTeam?: boolean
}

/** Flatten `me.memberships` (org → projects → teams) into the team list. */
export const teamsFromMe = (me: MeResponse | null): Team[] => {
  if (me?.auth.providerType === 'uoa' && me.uoaTeams?.length) {
    const localOrganizationNames = new Map<string, string>(
      me.memberships?.flatMap((membership) => membership.organizationName
        ? [[membership.organizationId, membership.organizationName] as const]
        : []) ?? [],
    )
    return me.uoaTeams.map((team) => ({
      organizationId: team.organizationId,
      projectId: '',
      teamId: team.teamId,
      ...(team.avatarTeamId ? { avatarTeamId: team.avatarTeamId } : {}),
      ...(team.avatarImageUrl ? { avatarImageUrl: team.avatarImageUrl } : {}),
      label: team.label,
      orgName: team.orgName ?? localOrganizationNames.get(team.organizationId),
      active: team.active,
      uoaTeam: true,
    }))
  }
  if (!me?.memberships) {
    return []
  }
  const list: Team[] = []
  for (const org of me.memberships) {
    for (const project of org.projects) {
      for (const team of project.teams) {
        list.push({
          organizationId: org.organizationId,
          projectId: project.projectId,
          teamId: team.teamId,
          label: team.teamName ?? project.projectName ?? 'Team',
          orgName: org.organizationName,
        })
      }
    }
  }
  return list
}

/** Keep UOA's directory order, but surface the current team first. */
export const orderTeamsWithActiveFirst = (
  teams: Team[],
  activeTeamId: string | null,
): Team[] => [
  ...teams.filter((team) => team.active || team.teamId === activeTeamId),
  ...teams.filter((team) => !team.active && team.teamId !== activeTeamId),
]

/** The team the session is currently scoped to, if it is still listed. */
export const activeTeam = (me: MeResponse | null): Team | null =>
  teamsFromMe(me).find(
    (team) => team.active || team.teamId === me?.context.teamId,
  )
  ?? null
