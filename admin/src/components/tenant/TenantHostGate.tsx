import { useEffect, useRef, type ReactNode } from 'react'

import { useTenantHost } from '../../facades/team/tenant-host'
import { useAuthSession } from '../../providers/AuthSessionProvider'
import { OrgPortal } from './OrgPortal'

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
 * - **Anything else** renders the app untouched. That is every deployment with
 *   no tenant base domain configured, which is all of them until one opts in.
 */
export const TenantHostGate = ({ children }: { children: ReactNode }) => {
  const { data, isLoading } = useTenantHost()
  const { switchUoaTeam, token } = useAuthSession()
  const switched = useRef<string | null>(null)

  const team = data?.kind === 'team' ? data.team : null

  useEffect(() => {
    if (!token || !team) return
    const key = `${team.externalOrgId}:${team.externalTeamId}`
    // Once per team per page load: a failed switch must leave the person where
    // they are rather than retrying forever against a team they cannot open.
    if (switched.current === key) return
    switched.current = key

    void switchUoaTeam({
      organizationId: team.externalOrgId,
      teamId: team.externalTeamId,
    }).catch(() => undefined)
  }, [team, switchUoaTeam, token])

  // Render nothing at all while the hostname is still being resolved, but only
  // when it could plausibly be a tenant host — otherwise every ordinary load
  // would flash an empty frame waiting for a request it never made.
  if (isLoading && !data) return null

  if (data?.kind === 'organisation') {
    return <OrgPortal organisation={data.organisation} signInOrigin={data.signInOrigin} />
  }

  return <>{children}</>
}
