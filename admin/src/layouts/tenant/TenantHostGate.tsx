import { useEffect, useRef, type ReactNode } from 'react'

import { useTenantHost, useTenantTeam } from '../../facades/team/tenant-host'
import { isNativeShell, nativeShellRecoveryHref } from '../../lib/tenant-navigation'
import { useAuthSession } from '../../providers/AuthSessionProvider'
import { OrgPortal } from './OrgPortal'
import { TeamHostSignIn } from './TeamHostSignIn'
import { tenantTeamSwitchNeeded } from './tenant-team-switch'

/**
 * What the browser's hostname means, decided once, above the router.
 *
 * Three outcomes:
 *
 * - **An organisation's address** (`<org>.<base>`) renders that tenant's portal
 *   instead of the app. It sits above the router deliberately: the branded page
 *   has to appear for somebody who is not signed in, and every route below
 *   redirects an anonymous visitor to login.
 * - **A team's address** (`<team>.<org>.<base>`) renders the app as usual, and
 *   switches the session onto that team so a cold load lands where the address
 *   says. Resolving a name grants nothing — the switch that follows is where
 *   membership is checked, and it fails closed for a team the person is not in.
 *   With no session it shows the tenant's branded sign-in instead of falling
 *   through to the product's marketing page, which is what a customer's team
 *   address used to serve their own people.
 * - **Anything else** renders the app untouched. That is every deployment with
 *   no tenant base domain configured, which is all of them until one opts in.
 */
export const TenantHostGate = ({ children }: { children: ReactNode }) => {
  const { data, isLoading } = useTenantHost()
  const { me, sessionState, switchUoaTeam, token } = useAuthSession()
  const switched = useRef<string | null>(null)

  // The ids only exist for a signed-in caller on a team host — the public
  // resolver above never carries them.
  const { data: teamData } = useTenantTeam(Boolean(token) && data?.kind === 'team')
  const team = teamData?.team ?? null

  // A native shell's bridge is refused on a tenant host — the title bar stops
  // dragging the window — so it goes back to the canonical origin however it
  // got here (lib/tenant-navigation.ts).
  const recoveryHref = data?.kind
    ? nativeShellRecoveryHref({
        canonicalOrigin: data.signInOrigin,
        currentUrl: window.location.href,
        hostKind: data.kind,
        inNativeShell: isNativeShell(),
      })
    : null

  useEffect(() => {
    if (recoveryHref) window.location.replace(recoveryHref)
  }, [recoveryHref])

  useEffect(() => {
    // `me` is needed to know which team the session is already on. A shell
    // leaving this host keeps the team it has rather than switching onto this one.
    if (recoveryHref || !token || !team || !me) return
    const key = `${team.externalOrgId}:${team.externalTeamId}`
    // Once per team per page load: a failed switch must leave the person where
    // they are rather than retrying forever against a team they cannot open.
    if (switched.current === key) return
    switched.current = key

    // Arriving here from the team switcher, the session is already on this
    // team; switching again only races the page-load refresh into a 409.
    if (!tenantTeamSwitchNeeded(me, team)) return

    void switchUoaTeam({
      organizationId: team.externalOrgId,
      teamId: team.externalTeamId,
    }).catch(() => undefined)
  }, [me, recoveryHref, team, switchUoaTeam, token])

  // Render nothing at all while the hostname is still being resolved, but only
  // when it could plausibly be a tenant host — otherwise every ordinary load
  // would flash an empty frame waiting for a request it never made.
  if (isLoading && !data) return null

  // Leaving this host: nothing of the tenant is drawn on the way out.
  if (recoveryHref) return null

  if (data?.kind === 'organisation') {
    return <OrgPortal organisation={data.organisation} signInOrigin={data.signInOrigin} />
  }

  // Only once the session has actually settled. 'loading' would flash the
  // sign-in card at somebody who is signed in, and 'bootstrap' is the
  // first-run flow, which owns the screen and must not be interrupted by a
  // tenant's branding.
  if (data?.kind === 'team' && sessionState === 'unauthenticated') {
    return <TeamHostSignIn organisation={data.organisation} signInOrigin={data.signInOrigin} />
  }

  return <>{children}</>
}
