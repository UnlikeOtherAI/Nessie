import { useMemo, useState } from 'react'

import type { TenantOrganisation } from '../../facades/team/tenant-host'
import { teamsFromMe, type Team } from '../../lib/teams'
import { useAuthSession } from '../../providers/AuthSessionProvider'

/**
 * A tenant's own front door, served at `<org>.<base domain>`.
 *
 * Two states, and the split between them is a privacy rule rather than a
 * layout choice:
 *
 * - **Signed out** — the organisation's mark and name, and a way in. The label
 *   is guessable, so showing whose address this is discloses nothing the
 *   hostname did not already.
 * - **Signed in** — the teams THIS PERSON belongs to inside that organisation,
 *   read from their own session. The list is never derived from the hostname,
 *   so a guessable address can never become a directory of a customer's
 *   internal structure.
 *
 * Sign-in itself happens on the product's canonical origin: UOA matches
 * redirect URLs byte-for-byte and tenant hostnames are created at runtime, so
 * they can never be registered redirect targets. The visitor is handed off and
 * returned here.
 */

const initialsOf = (name: string): string =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? '')
    .join('') || '?'

const OrgMark = ({ org, size }: { org: TenantOrganisation; size: number }) => {
  if (org.iconUrl) {
    return (
      <img
        alt=""
        className="rounded-[var(--radius-lg)] object-cover"
        height={size}
        src={org.iconUrl}
        width={size}
      />
    )
  }
  return (
    <div
      aria-hidden
      className={[
        'flex items-center justify-center rounded-[var(--radius-lg)]',
        'bg-[color:var(--accent)] font-semibold text-[color:var(--accent-tx)]',
      ].join(' ')}
      style={{ height: size, width: size, fontSize: Math.round(size / 2.6) }}
    >
      {initialsOf(org.name)}
    </div>
  )
}

export const OrgPortal = ({
  organisation,
  signInOrigin,
}: {
  organisation: TenantOrganisation
  signInOrigin: string | null
}) => {
  const { me, sessionState, switchUoaTeam } = useAuthSession()

  // Only this person's own memberships, and only those inside the organisation
  // whose address they opened.
  const teams = useMemo(
    () =>
      teamsFromMe(me).filter((team) => team.organizationId === organisation.externalOrgId),
    [me, organisation.externalOrgId],
  )

  const signedIn = sessionState === 'authenticated' && Boolean(me)
  const [busyTeamId, setBusyTeamId] = useState<string | null>(null)

  /**
   * Enter a team from the portal.
   *
   * The same silent switch the team picker runs — not a bare navigation, which
   * would land in the shell with the session still pointing at whichever team
   * it last held.
   */
  const openTeam = async (team: Team) => {
    if (busyTeamId) return
    setBusyTeamId(team.teamId)
    try {
      await switchUoaTeam({ organizationId: team.organizationId, teamId: team.teamId })
      window.location.assign('/channels')
    } catch {
      // Leave the portal up rather than a blank screen; the person can retry
      // or pick another team.
      setBusyTeamId(null)
    }
  }

  const handleSignIn = () => {
    const target = signInOrigin?.replace(/\/+$/, '')
    const back = encodeURIComponent(window.location.href)
    // Without a configured canonical origin there is nowhere safe to send
    // somebody, so fall back to this host's own login route rather than
    // guessing an origin.
    window.location.href = target ? `${target}/login?return=${back}` : '/login'
  }

  return (
    <main
      className={[
        'flex min-h-screen flex-col items-center justify-center gap-6',
        'bg-[color:var(--main)] px-6 py-12 text-[color:var(--tx)]',
      ].join(' ')}
    >
      <div className="flex flex-col items-center gap-4 text-center">
        <OrgMark org={organisation} size={72} />
        <div>
          <h1 className="text-xl font-semibold">{organisation.name}</h1>
          <p className="mt-1 text-sm text-[color:var(--tx3)]">
            {window.location.hostname}
          </p>
        </div>
      </div>

      {!signedIn ? (
        <button
          className={[
            'rounded-[var(--radius-md)] bg-[color:var(--accent)] px-5 py-2.5',
            'text-sm font-medium text-[color:var(--accent-tx)]',
          ].join(' ')}
          onClick={handleSignIn}
          type="button"
        >
          Sign in
        </button>
      ) : teams.length === 0 ? (
        <p className="max-w-sm text-center text-sm text-[color:var(--tx3)]">
          You are signed in, but you are not a member of any team in{' '}
          {organisation.name}. Ask someone in the organisation to invite you.
        </p>
      ) : (
        <ul className="flex flex-wrap items-stretch justify-center gap-3">
          {teams.map((team) => (
            <li key={team.teamId}>
              <button
                className={[
                  'flex w-36 flex-col items-center gap-3 rounded-[var(--radius-lg)]',
                  'border border-[color:var(--bd)] bg-[color:var(--surface)] p-4',
                  'text-center text-sm hover:border-[color:var(--accent)]',
                  'disabled:opacity-60',
                ].join(' ')}
                disabled={busyTeamId !== null}
                onClick={() => void openTeam(team)}
                type="button"
              >
                {team.avatarImageUrl ? (
                  <img
                    alt=""
                    className="h-12 w-12 rounded-[var(--radius-md)] object-cover"
                    src={team.avatarImageUrl}
                  />
                ) : (
                  <div
                    aria-hidden
                    className={[
                      'flex h-12 w-12 items-center justify-center rounded-[var(--radius-md)]',
                      'bg-[color:var(--bg2)] font-medium text-[color:var(--tx2)]',
                    ].join(' ')}
                  >
                    {initialsOf(team.label)}
                  </div>
                )}
                <span className="line-clamp-2 font-medium">{team.label}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </main>
  )
}
