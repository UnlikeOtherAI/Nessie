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

/**
 * Owner, and only owner, among the roles an action context carries — the
 * comparison `requireOwner` makes.
 *
 * It is a third predicate rather than a parameter on `isAdminActor` because
 * the two answer different questions and the file's own note says so: several
 * decisions are deliberately owner-only and admin is not a substitute. Placing
 * an agent in a channel is one of them (`POST /api/agents/:agentId/bindings`),
 * and a client that needs to know whether to draw that control must read one
 * server-computed answer rather than re-derive this comparison.
 */
export const isOwnerActor = (actorContext: AccessContext): boolean =>
  (actorContext.actor.roles ?? []).includes('owner')

/** Owner, and only owner, from the role on a membership row. */
export const isOwnerRole = (role: string | null | undefined): boolean =>
  role === 'owner'
