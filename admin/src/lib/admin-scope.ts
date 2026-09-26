/**
 * The scope switch on the Organisation pages whose data exists at the
 * organisation and at each team — People, AI models, Company connections and
 * Keys (docs/plans/2026-09-26-admin-ux-overhaul.md §6.8). One page per
 * concern; which level it shows is `?scope=`: `organisation`, or
 * `team:<teamId>`.
 *
 * Pure, so the rules the switch keeps are tested without a router:
 *
 * - **Entitlement decides the choices.** A page lists the scopes its API
 *   answers for this viewer; one the viewer could use with more standing is
 *   listed disabled with the reason, never left out and never a refusal after
 *   the fact.
 * - **The target is named.** A write goes where the address says. An address
 *   naming a team this page does not offer the viewer is an error, never a
 *   quiet fall-back to the organisation or to the team the session is in; and
 *   when the organisation is not the viewer's, the team they land on is
 *   written into the address, so a reload or a shared link keeps the target.
 */

export const ORGANISATION_SCOPE = 'organisation'

const TEAM_SCOPE_PREFIX = 'team:'

export type AdminScope = { kind: 'organisation' } | { kind: 'team'; teamId: string }

export const teamScopeValue = (teamId: string): string => `${TEAM_SCOPE_PREFIX}${teamId}`

/** One Organisation page with a team already chosen: the team page's doorways. */
export const teamScopedPath = (path: string, teamId: string): string =>
  `${path}?scope=${TEAM_SCOPE_PREFIX}${encodeURIComponent(teamId)}`

/** Only ever read from a value the page itself offered. */
export const adminScopeOf = (value: string): AdminScope =>
  value.startsWith(TEAM_SCOPE_PREFIX)
    ? { kind: 'team', teamId: value.slice(TEAM_SCOPE_PREFIX.length) }
    : { kind: 'organisation' }

export type AdminScopeOption = {
  label: string
  /** Present when the viewer may not use this scope here: who can, in a sentence. */
  unavailableReason?: string
  value: string
}

export type AdminScopeResolution =
  | { status: 'loading' }
  /** The teams could not be read, so no team scope can be offered or checked. */
  | { status: 'failed' }
  /** No scope on this page is the viewer's to use. */
  | { status: 'refused' }
  /**
   * No scope named, and the organisation is not the viewer's: this team is
   * where they land, and it is written into the address before anything is
   * shown under it.
   */
  | { option: AdminScopeOption; status: 'landing' }
  | { option: AdminScopeOption; scope: AdminScope; status: 'ready' }
  /** The address names a scope this viewer may not use here. */
  | { option: AdminScopeOption; status: 'unavailable' }
  /** The address names a scope this page does not have: an unknown or foreign team. */
  | { requested: string; status: 'unknown' }

const ready = (option: AdminScopeOption): AdminScopeResolution => ({
  option,
  scope: adminScopeOf(option.value),
  status: 'ready',
})

export const resolveAdminScope = ({
  failed = false,
  options,
  preferredTeamId = null,
  requested,
}: {
  failed?: boolean
  /** Null while the facts that decide them are still loading. */
  options: readonly AdminScopeOption[] | null
  /**
   * The team to land on when the organisation is not the viewer's and the
   * address names none — used only if it is one of the viewer's choices.
   */
  preferredTeamId?: string | null
  /** What the address names: the raw `?scope=`, or null when it names none. */
  requested: string | null
}): AdminScopeResolution => {
  if (failed) return { status: 'failed' }
  if (!options) return { status: 'loading' }
  const usable = options.filter((option) => !option.unavailableReason)
  const [firstUsable] = usable
  if (!firstUsable) return { status: 'refused' }

  if (requested === null) {
    const organisation = usable.find((option) => option.value === ORGANISATION_SCOPE)
    if (organisation) return ready(organisation)
    const preferred = preferredTeamId
      ? usable.find((option) => option.value === teamScopeValue(preferredTeamId))
      : undefined
    return { option: preferred ?? firstUsable, status: 'landing' }
  }

  const named = options.find((option) => option.value === requested)
  if (!named) return { requested, status: 'unknown' }
  if (named.unavailableReason) return { option: named, status: 'unavailable' }
  return ready(named)
}
