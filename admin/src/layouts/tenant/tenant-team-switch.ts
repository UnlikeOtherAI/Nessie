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

/**
 * Whether a team address is still settling, and the app must not be drawn yet.
 *
 * Arriving at `<team>.<org>.<base>` used to render the whole app immediately,
 * against whichever team the session was already on — the previous
 * organisation's channels and sidebar — and then tear it down when the switch
 * landed. Every input below is something that, left outstanding, produces
 * exactly that: an address that has not resolved to a team, a session that has
 * not been read, a switch that is needed, and a switch that is in flight.
 *
 * `switching` is separate from "needed" on purpose: the predicate above goes
 * false the moment the request is sent, so without it the curtain would lift
 * while the session was still moving.
 *
 * A signed-out visitor is never settling — a team address shows them the
 * tenant's sign-in — and neither is any host that is not a team's.
 */
export const teamHostSettling = (input: {
  hasToken: boolean
  hostKind: 'organisation' | 'team' | null | undefined
  me: MeResponse | null
  sessionState: string
  switching: boolean
  team: TenantTeam | null
  teamLoading: boolean
}): boolean => {
  if (input.hostKind !== 'team') return false
  if (input.sessionState === 'unauthenticated') return false
  if (!input.hasToken) return false
  if (input.teamLoading || input.switching) return true
  if (!input.team || !input.me) return false
  return tenantTeamSwitchNeeded(input.me, input.team)
}
