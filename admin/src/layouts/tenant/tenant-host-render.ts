/**
 * What a tenant hostname renders, as a decision separate from rendering it.
 *
 * `TenantHostGate` used to answer this with a chain of early returns, and the
 * defect that chain hid is the reason this is a function: the app fell through
 * to `children` whenever the team behind the address was not *known* to be
 * wrong — a failed `/api/hosts/team`, an unanswered one, a session that had
 * not loaded yet — and rendered the previous team's channels under a URL
 * naming a different one. Written as branches over the facts, the fall-through
 * has to be spelled out, and the tests below it can enumerate every state
 * instead of matching the source.
 *
 * The rule the branches encode: **on a team address, the app renders only when
 * the address has been verified and the session is on the team it names.**
 * Anything else is either still deciding, or a refusal.
 */

export type TenantHostRender =
  /** The hostname has not resolved yet, and it could be a tenant's. */
  | 'resolving'
  /** A native shell is leaving this host; draw nothing on the way out. */
  | 'recovering'
  /** An organisation's front door. */
  | 'portal'
  /** A team address with nobody signed in: the tenant's branded way in. */
  | 'sign-in'
  /** A team address this session cannot open, or cannot be shown to be able to. */
  | 'unavailable'
  /** A team address that has not finished agreeing with the session. */
  | 'waiting'
  /** The ordinary app. */
  | 'app'

export const tenantHostRender = ({
  hostKind,
  hostResolved,
  recovering,
  sessionState,
  signedIn,
  switchState,
  teamAnswered,
  teamFailed,
  teamKnown,
}: {
  /** What `/api/hosts/resolve` said; null for an ordinary host. */
  hostKind: 'organisation' | 'team' | null
  /** Whether that question has been answered at all. */
  hostResolved: boolean
  recovering: boolean
  sessionState: 'loading' | 'unauthenticated' | 'bootstrap' | 'authenticated'
  /**
   * A bearer exists. Deliberately not the same as an authenticated session:
   * the token is read synchronously from storage, so it is present before
   * `/api/auth/me` has answered.
   */
  signedIn: boolean
  switchState: 'idle' | 'switching' | 'failed'
  /** `/api/hosts/team` has answered, either way. */
  teamAnswered: boolean
  teamFailed: boolean
  /** It answered with ids. */
  teamKnown: boolean
}): TenantHostRender => {
  if (recovering) return 'recovering'
  if (!hostResolved) return 'resolving'
  if (hostKind === 'organisation') return 'portal'
  if (hostKind !== 'team') return 'app'

  // Signed out on a team address: the tenant's own door, never the product's
  // marketing page, which is what a customer's people used to get.
  if (sessionState === 'unauthenticated') return 'sign-in'
  // First-run setup owns the screen; a tenant's branding must not interrupt it.
  if (sessionState === 'bootstrap') return 'app'
  if (!signedIn) return 'waiting'

  // A refused switch, or ids this deployment could not produce. `{team: null}`
  // does not mean "no team here" — the hostname already resolved as a team, so
  // it means UOA could not be reached or the team is no longer federated.
  // Either way the address cannot be verified, and an address that cannot be
  // verified must not be served.
  if (switchState === 'failed' || teamFailed || (teamAnswered && !teamKnown)) {
    return 'unavailable'
  }
  if (switchState === 'switching' || !teamAnswered) return 'waiting'
  // The session has to have answered too, or the routes below mount and fetch
  // in whatever team the previous page left behind.
  if (sessionState !== 'authenticated') return 'waiting'
  return 'app'
}
