import { isDesktopApp } from './desktop'
import { isReactNativeWebView } from './native-shell'

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
  currentHostServesApp,
  inNativeShell,
  teamUrl,
}: {
  /** The product's own origin (`signInOrigin`), used only where this host cannot show the app. */
  canonicalOrigin: string | null
  currentHost: string
  /** False on an organisation portal, which renders the portal for every path. */
  currentHostServesApp: boolean
  inNativeShell: boolean
  /** The team's own address from `/api/hosts/address`, or null. */
  teamUrl: string | null
}): TeamSwitchDestination => {
  const team = inNativeShell ? null : parseHost(teamUrl)
  if (team && team.host !== currentHost) {
    return { kind: 'document', href: new URL(TEAM_LANDING_PATH, team.origin).href }
  }
  if (currentHostServesApp) return { kind: 'in-app', path: TEAM_LANDING_PATH }

  const canonical = parseHost(canonicalOrigin)
  if (canonical && canonical.host !== currentHost) {
    return { kind: 'document', href: new URL(TEAM_LANDING_PATH, canonical.origin).href }
  }
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
  currentHostServesApp: boolean
  fetchTeamUrl: () => Promise<string | null>
  inNativeShell: boolean
}): Promise<TeamSwitchDestination> =>
  teamSwitchDestination({
    ...facts,
    inNativeShell,
    teamUrl: inNativeShell ? null : await fetchTeamUrl(),
  })

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
