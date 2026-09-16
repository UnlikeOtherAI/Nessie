import { useEffect, useRef, useState, type ReactNode } from 'react'

import { useTenantHost, useTenantTeam, type TenantOrganisation } from '../../facades/team/tenant-host'
import { isNativeShell, nativeShellRecoveryHref } from '../../lib/tenant-navigation'
import { useAuthSession } from '../../providers/AuthSessionProvider'
import { OrgPortal } from './OrgPortal'
import { TeamHostSignIn } from './TeamHostSignIn'
import { TeamSwitchCurtain, useCurtainReveal } from './TeamSwitchCurtain'
import { teamHostSettling, tenantTeamSwitchNeeded } from './tenant-team-switch'

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
  const teamQuery = useTenantTeam(Boolean(token) && data?.kind === 'team')
  const team = teamQuery.data?.team ?? null
  // A switch that is running, as distinct from one that is merely needed: the
  // predicate below goes false the moment the request is sent, and without
  // this the curtain would lift while the session was still moving.
  const [switching, setSwitching] = useState(false)

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

    setSwitching(true)
    void switchUoaTeam({
      organizationId: team.externalOrgId,
      teamId: team.externalTeamId,
    })
      .catch(() => undefined)
      // Whether it worked or not. A failed switch leaves the person on the
      // team they had — which is the existing behaviour — and the curtain must
      // lift onto that rather than hang over a working app forever.
      .finally(() => setSwitching(false))
  }, [me, recoveryHref, team, switchUoaTeam, token])

  // Everything that has to finish before the app may be drawn on a team host:
  // the address has to resolve to a team, the session has to be readable, and
  // the session has to be on that team. Any one of them outstanding and the
  // app would render against whichever team the session was on before — which
  // is the previous organisation's workspace, shown and then swapped out.
  //
  // A signed-out visitor is not settling: they get the tenant's sign-in below.
  const settling = teamHostSettling({
    hasToken: Boolean(token),
    hostKind: data?.kind,
    me,
    sessionState,
    switching,
    team,
    teamLoading: teamQuery.isLoading,
  })

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

  return (
    <TeamHostCurtain
      organisation={data?.kind === 'team' ? data.organisation : null}
      settling={settling}
    >
      {children}
    </TeamHostCurtain>
  )
}

/**
 * Mounts the app only once the session is on this host's team, and fades the
 * tenant's curtain off the top of it.
 *
 * Separate from the gate because the reveal is stateful and the gate above it
 * returns early in four different ways; a hook cannot live behind those.
 */
const TeamHostCurtain = ({ children, organisation, settling }: {
  children: ReactNode
  organisation: TenantOrganisation | null
  settling: boolean
}) => {
  const revealed = useCurtainReveal(!settling)
  if (!organisation) return <>{children}</>
  return (
    <>
      {settling ? null : children}
      {revealed ? null : <TeamSwitchCurtain fading={!settling} organisation={organisation} />}
    </>
  )
}
