/**
 * Where a successful UOA team switch should take the address bar.
 *
 * In a browser on a deployment that routes tenants by hostname, the page moves
 * to the team's own address so the URL names the team the session is on
 * (docs/standards/team-hosts.md, "The address bar follows the switch").
 *
 * A native shell never follows. The desktop (Tauri) shell grants its IPC —
 * deep links, notifications, the title bar — only to the product's canonical
 * origin, so a tenant hostname loaded as its top-level document loses the
 * shell's bridge: the external-auth listener is refused and reports "The
 * external sign-in could not be completed.", and the tenant host gate then
 * re-runs a switch that races the page-load refresh into a 409. The React
 * Native WebView is pinned to the canonical origin the same way. The switch has
 * already committed on the server, so staying on the current origin and
 * navigating in-app is complete.
 *
 * Pure so the decision is testable without a window; callers pass the facts.
 */
export const teamHostRedirectUrl = ({
  currentHost,
  hostUrl,
  inNativeShell,
}: {
  currentHost: string
  hostUrl: string | null
  inNativeShell: boolean
}): string | null => {
  if (inNativeShell || !hostUrl) return null
  let target: URL
  try {
    target = new URL(hostUrl)
  } catch {
    return null
  }
  if (target.host === currentHost) return null
  return `${hostUrl}/channels`
}
