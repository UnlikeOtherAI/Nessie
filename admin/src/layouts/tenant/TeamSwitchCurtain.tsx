import { useEffect, useState } from 'react'

import type { TenantOrganisation } from '../../facades/team/tenant-host'

/**
 * What a team address shows while the session is still moving onto its team.
 *
 * Without it, arriving at `<team>.<org>.<base>` drew the whole app against the
 * team the session was *already* on — the previous organisation's channels,
 * its sidebar, its name in the corner — and then tore all of it down when the
 * switch landed a moment later. Nothing was broken; it simply showed the
 * person somebody else's workspace and then swapped it out under them.
 *
 * So the app is not mounted until the session is on the right team, and this
 * covers the gap in the tenant's own colours. It is a curtain rather than a
 * spinner in a corner: the point is that no part of the wrong organisation is
 * ever visible, not that something is spinning.
 */
export const TeamSwitchCurtain = ({ fading, organisation }: {
  fading: boolean
  organisation: TenantOrganisation
}) => (
  <div
    aria-busy="true"
    aria-live="polite"
    className="team-switch-curtain"
    data-fading={fading ? 'true' : undefined}
    role="status"
  >
    <div className="team-switch-curtain__mark">
      {organisation.iconUrl
        ? <img alt="" height={56} src={organisation.iconUrl} width={56} />
        : <span aria-hidden="true">{organisation.name.slice(0, 1).toUpperCase()}</span>}
    </div>
    <p className="team-switch-curtain__name">{organisation.name}</p>
    <p className="team-switch-curtain__hint">Opening your team…</p>
  </div>
)

/**
 * Holds the curtain up until `ready`, then fades it out and reports when it is
 * finished, so the caller can unmount it.
 *
 * The delay is a timer rather than a `transitionend` listener: a browser that
 * never fires the event — a background tab, reduced motion, a transition the
 * stylesheet dropped — would otherwise leave the curtain up forever, covering
 * a perfectly working app. A timer cannot fail that way.
 */
export const useCurtainReveal = (ready: boolean, durationMs = 320): boolean => {
  const [revealed, setRevealed] = useState(false)
  useEffect(() => {
    if (!ready) return undefined
    const timer = window.setTimeout(() => setRevealed(true), durationMs)
    return () => window.clearTimeout(timer)
  }, [durationMs, ready])
  return revealed
}
