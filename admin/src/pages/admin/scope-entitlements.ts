import {
  ORGANISATION_SCOPE,
  teamScopeValue,
  type AdminScopeOption,
} from '../../lib/admin-scope'
import type { TeamRecord } from '../../lib/api-client'

/**
 * Which scopes each scoped Organisation page offers a viewer, decided by the
 * API gate each scope's reads and writes carry — never by the team the
 * session happens to be in. A scope the viewer could use with more standing
 * is listed disabled with the reason; the page renders the switch, and a team
 * page's doorways read the same answer, so a doorway never opens a refusal.
 *
 * These are render gates only: every route re-resolves the caller's live role.
 */

export type ScopeViewer = {
  /** Owner or admin of the organisation — `requireOrgAdmin` on the API. */
  isOrganizationAdmin: boolean
  isOwner: boolean
}

type ScopeTeam = Pick<TeamRecord, 'id' | 'name' | 'viewerIsMember'>

const organisationOption = (unavailableReason?: string): AdminScopeOption => ({
  label: 'Organisation',
  value: ORGANISATION_SCOPE,
  ...(unavailableReason ? { unavailableReason } : {}),
})

const teamOptions = (
  teams: readonly ScopeTeam[],
  unavailableReason?: string,
): AdminScopeOption[] =>
  teams.map((team) => ({
    label: team.name,
    value: teamScopeValue(team.id),
    ...(unavailableReason ? { unavailableReason } : {}),
  }))

/** The choice a team page's doorway opens, for the one team it shows. */
export const teamScopeOption = (
  options: readonly AdminScopeOption[],
  teamId: string,
): AdminScopeOption | undefined =>
  options.find((option) => option.value === teamScopeValue(teamId))

/**
 * AI models. The organisation's catalogue answers its owner only
 * (`GET /api/inference/model-catalog` is `requireOwner`, and so is Test); a
 * team's answers any owner or admin, for every team in the organisation
 * (`/api/teams/:teamId/inference/model-catalog` is `requireOrgAdmin`). An
 * admin therefore sees the organisation disabled, with the reason, and works
 * in a team.
 */
export const modelScopeOptions = (
  viewer: ScopeViewer,
  teams: readonly ScopeTeam[],
): AdminScopeOption[] => [
  organisationOption(
    viewer.isOwner ? undefined : 'Only the organisation owner chooses the organisation’s models.',
  ),
  ...teamOptions(
    teams,
    viewer.isOrganizationAdmin ? undefined : 'Only organisation owners and admins narrow a team’s models.',
  ),
]

/**
 * Keys. Saving or revoking a key above a person's own is the owner's, at the
 * organisation and at every team alike (`canManageSecretScope`).
 */
export const keyScopeOptions = (
  viewer: ScopeViewer,
  teams: readonly ScopeTeam[],
): AdminScopeOption[] => {
  const reason = viewer.isOwner ? undefined : 'Only the organisation owner manages keys.'
  return [organisationOption(reason), ...teamOptions(teams, reason)]
}

/**
 * Company connections. A team's shared mailboxes are managed by any owner or
 * admin (`MANAGER_ROLES` in the mailbox routes), and the lock list at the
 * organisation is read by anyone; the company and team cloud browser accounts
 * are the owner's to connect, which their panel says in place.
 */
export const connectionScopeOptions = (
  viewer: ScopeViewer,
  teams: readonly ScopeTeam[],
): AdminScopeOption[] => {
  const reason = viewer.isOrganizationAdmin
    ? undefined
    : 'Only organisation owners and admins manage company connections.'
  return [organisationOption(reason), ...teamOptions(teams, reason)]
}

/**
 * People. The organisation's roster is answered to its administrators — on a
 * session from the sign-in provider by that provider's administration
 * capability, on a local install to the owner — and a team's roster to anybody
 * in the team. A team the viewer is not in is not listed: its roster is not
 * theirs to read short of administering the organisation, which is the
 * organisation scope.
 */
export const peopleScopeOptions = (
  { canSeeOrganization }: { canSeeOrganization: boolean },
  teams: readonly ScopeTeam[],
): AdminScopeOption[] => [
  organisationOption(
    canSeeOrganization ? undefined : 'Only organisation administrators see everyone in it.',
  ),
  ...teamOptions(teams.filter((team) => team.viewerIsMember)),
]
