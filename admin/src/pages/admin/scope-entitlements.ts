import type { OrganizationAdministrationStatus } from '../../facades/organization/hooks'
import {
  ORGANISATION_SCOPE,
  teamScopedPath,
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

/** A team page's row: the page it opens, or — greyed — who holds that page. */
export type ScopeDoorway = { href: string } | { reason: string }

/** Where a team page's doorway goes for this viewer, or who holds the page it would open. */
export const teamDoorway = (
  options: readonly AdminScopeOption[],
  path: string,
  teamId: string,
): ScopeDoorway => {
  const reason = teamScopeOption(options, teamId)?.unavailableReason
  return reason ? { reason } : { href: teamScopedPath(path, teamId) }
}

/**
 * The own-computers row opens AI models at the team's scope, but the policy
 * there answers only the organisation-administration standing — the sign-in
 * provider's capability on a bound organisation, which owner or admin alone is
 * not. So the row is a doorway only with that standing and otherwise greyed
 * with the reason: never a live row into a refusal. On an unbound local
 * install the server's answer already allows a local owner or admin.
 */
export const ownComputersDoorway = (
  models: ScopeDoorway,
  administration: OrganizationAdministrationStatus | undefined,
): ScopeDoorway => {
  if ('reason' in models || administration === 'allowed') return models
  if (administration === 'forbidden') {
    return { reason: 'Only an organisation administrator sees or sets this policy.' }
  }
  return administration === 'unavailable'
    ? { reason: 'Your organisation access could not be checked. Try again in a moment.' }
    : { reason: 'Checking who may see this policy…' }
}

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

type PeopleViewer = {
  administration: OrganizationAdministrationStatus | undefined
  isOwner: boolean
  /** A session from the sign-in provider rather than a local account. */
  isUoaSession: boolean
}

/**
 * Why the organisation's roster is not the viewer's, or undefined when it is.
 *
 * Two rosters answer to two gates. A session from the sign-in provider reads
 * the provider's roster, which answers the organisation-administration
 * standing. A local session reads the local roster, whose management is the
 * owner's alone — `/api/users` gives anybody else the directory view and every
 * roster write is `requireOwner` — so on a local install this is owner-only
 * even though the administration standing there also allows a local admin.
 */
const peopleOrganisationReason = (viewer: PeopleViewer): string | undefined => {
  if (!viewer.isUoaSession) {
    return viewer.isOwner ? undefined : 'Only the organisation owner manages the people on this install.'
  }
  if (viewer.administration === 'allowed') return undefined
  return viewer.administration === 'forbidden'
    ? 'Only organisation administrators see everyone in it.'
    : 'Your organisation access could not be checked. Try again in a moment.'
}

/**
 * People. The organisation's roster is answered to the people who manage it
 * (`peopleOrganisationReason`), and a team's roster to anybody in the team. A
 * team the viewer is not in is not listed: its roster is not theirs to read
 * short of administering the organisation, which is the organisation scope.
 */
export const peopleScopeOptions = (
  viewer: PeopleViewer,
  teams: readonly ScopeTeam[],
): AdminScopeOption[] => [
  organisationOption(peopleOrganisationReason(viewer)),
  ...teamOptions(teams.filter((team) => team.viewerIsMember)),
]
