import type { MeResponse } from '@nessie/schemas'

import type { TenantTeam } from '../../facades/team/tenant-host'
import type { TeamHandoffTarget } from '../../lib/tenant-team-handoff'

/**
 * Whether the session still has to be moved onto a team something else has
 * named — a team hostname, or a canonical-origin handoff.
 *
 * Arriving after the switch has already happened must not switch again: a
 * second `POST /api/auth/uoa/team` for the team the session is on races the
 * page-load refresh, which rotates the same refresh-cookie family, and loses
 * with `TEAM_SWITCH_CONFLICT`.
 *
 * The comparison is against UOA ids — `me.uoaTeams[].organizationId/teamId` —
 * never `me.context`, which carries local ids. A session without a UOA
 * directory cannot be proven to be on the team, so it still switches and the
 * server decides.
 */
const switchNeeded = (me: MeResponse | null, target: TeamHandoffTarget): boolean => {
  if (me?.auth.providerType !== 'uoa') return true
  const current = me.uoaTeams?.find((entry) => entry.active)
  if (!current) return true
  return current.organizationId !== target.organizationId || current.teamId !== target.teamId
}

/** The team hostname's ids, which UOA names `external*`. */
export const tenantTeamSwitchNeeded = (
  me: MeResponse | null,
  team: TenantTeam,
): boolean => switchNeeded(me, {
  organizationId: team.externalOrgId,
  teamId: team.externalTeamId,
})

/** The same question for a `?switchTeam=` handoff on the canonical origin. */
export const teamHandoffNeeded = switchNeeded

