import { useEffect, useRef, useState, type ReactNode } from 'react'

import {
  useTenantHost,
  useTenantTeam,
  type TenantOrganisation,
} from '../../facades/team/tenant-host'
import { isNativeShell, nativeShellRecoveryHref, TEAM_LANDING_PATH } from '../../lib/tenant-navigation'
import { useAuthSession } from '../../providers/AuthSessionProvider'
import { OrgPortal } from './OrgPortal'
import { TeamHostSignIn } from './TeamHostSignIn'
import { TeamSwitchCurtain, useCurtainReveal } from './TeamSwitchCurtain'
import { TenantBrandFrame } from './tenant-brand'
import { tenantHostRender } from './tenant-host-render'
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
 *
 * **The app does not mount until the address and the session agree.** Firing
 * the switch and rendering underneath it was the bug: the routes below started
 * fetching with the previous team's scope, and a switch that then failed —
 * silently, because the failure was swallowed — left the previous team's
 * channels, projects and search on screen under a URL naming a different one.
 * That is indistinguishable from the product ignoring the address, and it is
 * what somebody sees after copying a team link to a colleague.
 *
 * Which of those states draws what is `tenant-host-render.ts`, a pure function
 * over the facts this component gathers. It lives outside this file because
 * the fall-through above was a *missing* branch, and a missing branch is
 * invisible in a chain of early returns and obvious in an enumeration.
 */
export const TenantHostGate = ({ children }: { children: ReactNode }) => {
  const { data, isLoading } = useTenantHost()
  const { me, sessionState, switchUoaTeam, token } = useAuthSession()
  const switched = useRef<string | null>(null)
  const [switchState, setSwitchState] = useState<'idle' | 'switching' | 'failed'>('idle')

  // The ids only exist for a signed-in caller on a team host — the public
  // resolver above never carries them.
  const { data: teamData, isError: teamFailed } = useTenantTeam(
    Boolean(token) && data?.kind === 'team',
  )
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
    // It is claimed before the comparison below, so an in-app switch away from
    // this host — which navigates off it — is never dragged back here.
    if (switched.current === key) return
    switched.current = key

    // Arriving here from the team switcher, the session is already on this
    // team; switching again only races the page-load refresh into a 409.
    if (!tenantTeamSwitchNeeded(me, team)) return

    setSwitchState('switching')
    void switchUoaTeam({
      organizationId: team.externalOrgId,
      teamId: team.externalTeamId,
    }).then(
      () => setSwitchState('idle'),
      // Not a member, a session that needs re-authorising, a rotation
      // conflict: whichever it was, this address cannot be opened on this
      // session and saying so beats serving another team's screen under it.
      () => setSwitchState('failed'),
    )
  }, [me, recoveryHref, team, switchUoaTeam, token])

  // Not the same question as `switchState`: the effect above runs after this
  // render, so on the first paint the switch is needed and has not started.
  // Holding on `switchState` alone would show a frame of the team the session
  // came from.
  const switchNeeded = team !== null && me !== null && tenantTeamSwitchNeeded(me, team)

  const render = tenantHostRender({
    hostKind: data?.kind ?? null,
    // Only a hostname that could plausibly be a tenant's waits: otherwise
    // every ordinary load would flash an empty frame waiting for a request it
    // never made.
    hostResolved: Boolean(data) || !isLoading,
    recovering: Boolean(recoveryHref),
    sessionState,
    signedIn: Boolean(token),
    switchNeeded,
    switchState,
    teamAnswered: Boolean(teamData),
    teamFailed,
    teamKnown: Boolean(team),
  })

  if (render === 'recovering' || render === 'resolving') return null
  if (render === 'portal' && data?.kind === 'organisation') {
    return <OrgPortal organisation={data.organisation} signInOrigin={data.signInOrigin} />
  }
  if (data?.kind === 'team') {
    if (render === 'sign-in') {
      return <TeamHostSignIn organisation={data.organisation} signInOrigin={data.signInOrigin} />
    }
    if (render === 'unavailable') {
      return <TeamHostUnavailable organisation={data.organisation} signInOrigin={data.signInOrigin} />
    }
    // 'waiting' and 'app' share this subtree so the curtain can fade off the
    // app it was covering rather than cutting to it.
    return (
      <TeamHostCurtain organisation={data.organisation} settling={render === 'waiting'}>
        {children}
      </TeamHostCurtain>
    )
  }

  // Off a team host there is no tenant to brand a wait with, and nothing that
  // would render the wrong team underneath.
  if (render === 'waiting') return null
  return <>{children}</>
}

/**
 * Mounts the app only once the session is on this host's team, and fades the
 * tenant's curtain off the top of it.
 *
 * Separate from the gate because the reveal is stateful and the gate above it
 * returns early in several different ways; a hook cannot live behind those.
 */
const TeamHostCurtain = ({ children, organisation, settling }: {
  children: ReactNode
  organisation: TenantOrganisation
  settling: boolean
}) => {
  const revealed = useCurtainReveal(!settling)
  return (
    <>
      {settling ? null : children}
      {revealed ? null : <TeamSwitchCurtain fading={!settling} organisation={organisation} />}
    </>
  )
}

/**
 * This address exists, and this session cannot open it.
 *
 * Deliberately says nothing about the team: on a tenant hostname the team is
 * never named to somebody who has not been let in (docs/standards/team-hosts.md,
 * "The tenant's address is the tenant's brand"), and a refused switch is
 * exactly that case. The way out is the product's own origin, which serves
 * whatever team this person does have.
 */
const TeamHostUnavailable = ({
  organisation,
  signInOrigin,
}: {
  organisation: TenantOrganisation
  signInOrigin: string | null
}) => (
  <TenantBrandFrame organisation={organisation}>
    <p className="max-w-sm text-center text-sm text-[color:var(--tx3)]">
      This address could not be opened with your current session.
    </p>
    {/*
      * Always a way out. With no canonical origin configured there is nowhere
      * else to send anybody, so the action reloads this address — which is the
      * one thing that can help when the cause was UOA being briefly
      * unreachable, and the only alternative is a dead end.
      */}
    <a
      className={[
        'rounded-[var(--radius-md)] border border-[color:var(--bd)] px-4 py-2',
        'text-sm hover:border-[color:var(--accent)]',
      ].join(' ')}
      href={signInOrigin ? new URL(TEAM_LANDING_PATH, signInOrigin).href : TEAM_LANDING_PATH}
    >
      {signInOrigin ? 'Open Nessie' : 'Try again'}
    </a>
  </TenantBrandFrame>
)
