import { useEffect, useRef, useState, type ReactNode } from 'react'

import {
  parseTeamHandoff,
  teamHandoffSpentHref,
  type TeamHandoffTarget,
} from '../../lib/tenant-team-handoff'
import { useAuthSession } from '../../providers/AuthSessionProvider'
import { teamHandoffNeeded } from './tenant-team-switch'

/**
 * The receiving end of "open this team" on the canonical origin.
 *
 * A tenant address that this deployment cannot serve has nowhere to send a
 * switch except here, and arriving here used to mean arriving on whichever
 * team the session was last on — the person picked a team and the product
 * ignored them. `lib/tenant-team-handoff.ts` says why those teams exist and
 * why the ids in the URL are a request rather than a grant: the switch below
 * is the ordinary one, membership-checked server-side, and fails closed.
 *
 * It renders nothing while the switch is in flight. The alternative is to let
 * the app mount on the old team and swap underneath it, which is precisely the
 * failure this whole change is about — a URL naming one team over another
 * team's screen.
 *
 * On success it reloads the stripped address rather than routing: a switch
 * replaces the tenant context wholesale, and a fresh document is the one thing
 * that cannot be holding a query cached under the previous team. On failure —
 * a team this person is not in, a session that needs re-authorising — it
 * simply renders the app on the team the session already has. That is the same
 * place they would have landed before, so a refused handoff costs nothing.
 */
export const TeamHandoffGate = ({ children }: { children: ReactNode }) => {
  const { me, sessionState, switchUoaTeam } = useAuthSession()
  const [target] = useState<TeamHandoffTarget | null>(() =>
    typeof window === 'undefined' ? null : parseTeamHandoff(window.location.href))
  const [settled, setSettled] = useState(target === null)
  const attempted = useRef(false)

  useEffect(() => {
    if (!target || attempted.current) return
    // Only once the session has actually settled: 'loading' has no `me` to
    // compare against, and an anonymous visitor has no session to re-scope.
    if (sessionState !== 'authenticated' || !me) {
      if (sessionState === 'unauthenticated') setSettled(true)
      return
    }
    attempted.current = true

    // Already there — a reload of a spent link, or the session was on it all
    // along. Switching again would only race the page-load refresh, which
    // rotates the same refresh-cookie family, and lose with a conflict.
    if (!teamHandoffNeeded(me, target)) {
      setSettled(true)
      return
    }

    void switchUoaTeam({ organizationId: target.organizationId, teamId: target.teamId })
      .then(() => {
        window.location.replace(teamHandoffSpentHref(window.location.href))
      })
      .catch(() => setSettled(true))
  }, [me, sessionState, switchUoaTeam, target])

  if (!settled) return null
  return <>{children}</>
}
