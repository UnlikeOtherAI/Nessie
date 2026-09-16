import { isDesktopApp } from './desktop'
import { isReactNativeWebView } from './native-shell'
import { withTeamHandoff, type TeamHandoffTarget } from './tenant-team-handoff'

/**
 * Where the page goes after something moves the session between tenants: a
 * team switch from the rail, a team picked on an organisation portal, or the
 * sign-in round trip returning somebody to the tenant address they started on
 * (docs/standards/team-hosts.md, "The address bar follows the switch — in a
 * browser only").
 *
 * One policy for every entry point, because each of them used to decide on its
 * own and they disagreed:
 *
 * - **A browser follows the tenant's address**, so the URL names the team the
 *   session is on.
 * - **A native shell never loads a tenant hostname as its top-level document.**
 *   The desktop (Tauri) shell grants IPC — deep links, notifications, the title
 *   bar — only to the canonical origin
 *   (`desktop/src-tauri/capabilities/default.json`), so on a tenant host the
 *   external-auth listener is refused and reports "The external sign-in could
 *   not be completed.". The React Native WebView is pinned to the canonical
 *   origin the same way. The switch has already committed on the server, so
 *   staying on the current origin and navigating in-app is complete.
 * - **An organisation portal cannot navigate in-app.** `TenantHostGate` renders
 *   the portal for that hostname whatever the path, so `/channels` on the same
 *   host reloads the portal. It goes to the team's address, or failing that to
 *   the canonical origin.
 * - **No tenant host ever keeps a team that is not its own.** A team address
 *   serves the app, so staying there used to look like the cheap option — but
 *   the URL then names one team while the session is on another, a copied link
 *   sends a colleague to the wrong place, and the next load of that address
 *   switches the session back. Not every team has an address to go to instead:
 *   the lookups behind one are scoped to this product's UOA client domain, so
 *   an organisation founded on another product's domain has none, and its
 *   hostname does not even complete a TLS handshake. Those switches leave for
 *   the canonical origin, carrying the target team
 *   (`lib/tenant-team-handoff.ts`) so it opens on the team that was picked.
 */

export const TEAM_LANDING_PATH = '/channels'

export type TeamSwitchDestination =
  /** Move the top-level document to another origin. */
  | { kind: 'document'; href: string }
  /** Stay on this origin and navigate with the router. */
  | { kind: 'in-app'; path: string }
  /** Nowhere better to go: this host cannot show the app and nothing else is known. */
  | { kind: 'none' }

export const isNativeShell = (): boolean => isDesktopApp() || isReactNativeWebView()

const parseHost = (url: string | null): URL | null => {
  if (!url) return null
  try {
    return new URL(url)
  } catch {
    return null
  }
}

/** The pure decision; `resolveTeamSwitchDestination` supplies the team's address. */
export const teamSwitchDestination = ({
  canonicalOrigin,
  currentHost,
  currentHostIsTenant,
  currentHostServesApp,
  inNativeShell,
  targetTeam,
  teamUrl,
}: {
  /** The product's own origin (`signInOrigin`), used only where this host cannot show the app. */
  canonicalOrigin: string | null
  currentHost: string
  /**
   * Whether this hostname belongs to a tenant — an organisation portal or a
   * team address — rather than being the product's own origin. A tenant host
   * may serve the app and still be the wrong place to stay.
   */
  currentHostIsTenant: boolean
  /** False on an organisation portal, which renders the portal for every path. */
  currentHostServesApp: boolean
  inNativeShell: boolean
  /** The UOA ids of the team being switched to, for the canonical-origin handoff. */
  targetTeam: TeamHandoffTarget | null
  /** The team's own address from `/api/hosts/address`, or null. */
  teamUrl: string | null
}): TeamSwitchDestination => {
  const team = inNativeShell ? null : parseHost(teamUrl)
  if (team) {
    if (team.host !== currentHost) {
      return { kind: 'document', href: new URL(TEAM_LANDING_PATH, team.origin).href }
    }
    // Already at the team's own address: the URL is right, so routing is.
    if (currentHostServesApp) return { kind: 'in-app', path: TEAM_LANDING_PATH }
  }
  // The product's own origin serves every team, including the ones with no
  // address, so there is nothing to leave for.
  if (currentHostServesApp && !currentHostIsTenant) {
    return { kind: 'in-app', path: TEAM_LANDING_PATH }
  }

  const canonical = parseHost(canonicalOrigin)
  if (canonical && canonical.host !== currentHost) {
    const landing = new URL(TEAM_LANDING_PATH, canonical.origin).href
    return { kind: 'document', href: withTeamHandoff(landing, targetTeam) ?? landing }
  }
  // A tenant host with nowhere better to go. Staying is wrong, but a blank
  // screen is worse than a stale address bar, so the app still opens.
  if (currentHostServesApp) return { kind: 'in-app', path: TEAM_LANDING_PATH }
  return { kind: 'none' }
}

/**
 * The decision with the lookup attached. A native shell is never going to
 * follow a team's address, so it does not ask for one.
 */
export const resolveTeamSwitchDestination = async ({
  fetchTeamUrl,
  inNativeShell,
  ...facts
}: {
  canonicalOrigin: string | null
  currentHost: string
  currentHostIsTenant: boolean
  currentHostServesApp: boolean
  fetchTeamUrl: () => Promise<string | null>
  inNativeShell: boolean
  targetTeam: TeamHandoffTarget | null
}): Promise<TeamSwitchDestination> =>
  teamSwitchDestination({
    ...facts,
    inNativeShell,
    teamUrl: inNativeShell ? null : await fetchTeamUrl(),
  })

/**
 * Where a native shell goes when its top-level document is already on a tenant
 * host, or null to stay.
 *
 * The entry points above keep a native shell off tenant hosts, but a shell can
 * still arrive on one — a link opened in the window, an older admin bundle, a
 * path nobody has guarded yet — and nothing brought it back. There every IPC
 * call is refused, so the macOS title bar stops dragging the window and the
 * deep-link bridge fails until the app is relaunched. A team host serves the
 * app, so the same route opens on the canonical origin; an organisation portal
 * has no route of its own, so it lands on the team landing.
 */
export const nativeShellRecoveryHref = ({
  canonicalOrigin,
  currentUrl,
  hostKind,
  inNativeShell,
}: {
  /** The product's own origin (`signInOrigin`). */
  canonicalOrigin: string | null
  currentUrl: string
  /** What `/api/hosts/resolve` said this hostname is; null for an ordinary host. */
  hostKind: 'organisation' | 'team' | null
  inNativeShell: boolean
}): string | null => {
  if (!inNativeShell || !hostKind) return null
  const canonical = parseHost(canonicalOrigin)
  const current = parseHost(currentUrl)
  if (!canonical || !current || canonical.host === current.host) return null
  const path = hostKind === 'team'
    ? `${current.pathname}${current.search}${current.hash}`
    : TEAM_LANDING_PATH
  return new URL(path, canonical.origin).href
}

/**
 * Whether a stored tenant return address may be navigated to.
 *
 * `target` has already passed `parseTenantReturn`. In a native shell it is
 * dropped: the person is signed in on the canonical origin, which is the only
 * origin the shell's bridge works on, and that is where they stay.
 */
export const tenantReturnDestination = ({
  inNativeShell,
  target,
}: {
  inNativeShell: boolean
  target: string | null
}): string | null => (inNativeShell ? null : target)
