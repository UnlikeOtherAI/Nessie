import type { AccessContext } from './access-context.js'

/**
 * "Owner or admin" — the organisation roles that manage team-wide
 * settings. Strictly wider than owner-only, which several decisions still
 * require; this pair is not a substitute for those.
 *
 * It lives here because it is a contract rather than a local convention: the
 * organisation routes, the UOA roster relays, connector management, executor
 * access and dashboards all have to agree on who counts as a manager, and they
 * each read the role from a different place.
 */
export const ORGANIZATION_ADMIN_ROLES: ReadonlySet<string> = new Set(['owner', 'admin'])

/** Owner or admin, from the role on a membership row. */
export const isAdminRole = (role: string | null | undefined): boolean =>
  role !== null && role !== undefined && ORGANIZATION_ADMIN_ROLES.has(role)

/**
 * Owner or admin among the roles an action context carries.
 *
 * Deliberately a second predicate rather than a collapse into `isAdminRole`:
 * where those roles come from is the caller's business — an API request
 * re-resolves them from the live `OrganizationMember` row, a worker-derived
 * context may carry a snapshot — and only the comparison is shared.
 */
export const isAdminActor = (actorContext: AccessContext): boolean =>
  (actorContext.actor.roles ?? []).some((role) => ORGANIZATION_ADMIN_ROLES.has(role))
