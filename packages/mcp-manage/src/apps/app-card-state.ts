import type { AppCardState, AppConnectionStatus } from '@nessie/schemas'

/**
 * The one status an app card shows, decided server-side so the grid, the
 * detail page, and any later surface agree without each re-reading raw rows.
 *
 * Deliberately free of Prisma types: the precedence rules are the part worth
 * exercising directly, and a signature made of plain records is what lets that
 * happen without a database.
 *
 * Spec: `docs/plans/2026-08-29-mcp-app-store/ux-design-catalogue.md` §4.
 */

export type AppAvailability = {
  /** Moderation blocked the app instance-wide. */
  blocked: boolean
  /** Catalogue status `deprecated` — "No longer available". */
  deprecated: boolean
  /** Admin lock: members may no longer install it. */
  locked: boolean
  /** The last health probe could not reach the app's server. */
  serverUnreachable: boolean
}

const has = (
  statuses: readonly AppConnectionStatus[],
  status: AppConnectionStatus,
): boolean => statuses.includes(status)

/**
 * Precedence when several states apply: `error` > `auth_expired` >
 * `connecting` > `multiple_accounts` > `connected`. The decision-relevant
 * state wins on the card; the detail view enumerates the accounts behind it.
 *
 * Availability (locked / blocked / deprecated / unreachable) decides only when
 * the caller has **no** connection to this app. Locking is an install-time
 * gate — an already-installed connection keeps working — so painting a live,
 * usable connection as "Unavailable" would state something false and would
 * hide the Manage action that still applies.
 *
 * A set of connections that are *all* switched off is `paused`, never
 * `disabled`: the person did that and can undo it, so the card owes them a
 * "Turned off" label and a Manage action. `disabled` is reserved for the
 * availability verdict an admin or moderator reached, which has no action
 * behind it — reaching it from a paused connection stranded the one person who
 * could fix it.
 */
export const deriveAppCardState = (
  availability: AppAvailability,
  connectionStatuses: readonly AppConnectionStatus[],
): AppCardState => {
  if (connectionStatuses.length === 0) {
    if (availability.blocked || availability.deprecated || availability.locked) {
      return 'disabled'
    }
    return availability.serverUnreachable ? 'unavailable' : 'available'
  }

  if (has(connectionStatuses, 'error')) return 'error'
  if (has(connectionStatuses, 'expired')) return 'auth_expired'
  if (has(connectionStatuses, 'connecting')) return 'connecting'

  const live = connectionStatuses.filter((status) => status === 'connected').length
  if (live > 1) return 'multiple_accounts'
  if (live === 1) return 'connected'
  // Every account this caller can see is switched off — still theirs to turn
  // back on, so this stays in the connected family.
  return 'paused'
}
