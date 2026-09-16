import type { MeResponse } from '@nessie/schemas'

import type { TenantTeam } from '../../facades/team/tenant-host'

/**
 * Whether a team hostname still has to switch the session onto its team.
 *
 * Arriving on a team's address after the team switcher already moved the
 * session there must not switch again: a second `POST /api/auth/uoa/team` for
 * the team the session is on races the page-load refresh, which rotates the
 * same refresh-cookie family, and loses with `TEAM_SWITCH_CONFLICT`.
 *
 * The comparison is against UOA ids — `me.uoaTeams[].organizationId/teamId`
 * and the host's `externalOrgId/externalTeamId` — never `me.context`, which
 * carries local ids. A session without a UOA directory cannot be proven to be
 * on the team, so it still switches and the server decides.
 */
export const tenantTeamSwitchNeeded = (
  me: MeResponse | null,
  team: TenantTeam,
): boolean => {
  if (me?.auth.providerType !== 'uoa') return true
  const current = me.uoaTeams?.find((entry) => entry.active)
  if (!current) return true
  return current.organizationId !== team.externalOrgId || current.teamId !== team.externalTeamId
}
