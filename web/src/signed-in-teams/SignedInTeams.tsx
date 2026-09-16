import { faChevronRight } from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { useEffect, useState } from 'react'

import { fetchLandingTeams, type LandingTeam } from './landing-teams'

const initialsOf = (label: string): string =>
  label
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? '')
    .join('') || '?'

const TeamAvatar = ({ team }: { team: LandingTeam }) => {
  const [failed, setFailed] = useState(false)
  if (team.avatarImageUrl && !failed) {
    return (
      <img
        alt=""
        className="n-teams-avatar"
        height={40}
        onError={() => setFailed(true)}
        src={team.avatarImageUrl}
        width={40}
      />
    )
  }
  return (
    <span aria-hidden="true" className="n-teams-avatar n-teams-avatar-initials">
      {initialsOf(team.label)}
    </span>
  )
}

/**
 * The "Your teams" list, above everything the page has to say.
 *
 * A visitor who is already signed in did not come to read the pitch — they came
 * to get back into their team, and the doorway has to be the first thing on the
 * page rather than something to scroll past. Renders nothing for an empty list,
 * which is what a signed-out visitor always gets, so the anonymous homepage has
 * no section, no placeholder and nothing that moves.
 */
export const SignedInTeamsSection = ({ teams }: { teams: readonly LandingTeam[] }) => {
  if (teams.length === 0) return null
  return (
    <section aria-labelledby="n-teams-title" className="n-teams">
      <h2 className="n-teams-title" id="n-teams-title">Your teams</h2>
      <ul className="n-teams-list">
        {teams.map((team, index) => (
          <li key={`${team.href}-${team.label}-${index}`}>
            <a
              aria-current={team.active ? 'true' : undefined}
              className={team.active ? 'n-teams-entry n-teams-entry-active' : 'n-teams-entry'}
              href={team.href}
            >
              <TeamAvatar team={team} />
              <span className="n-teams-text">
                <span className="n-teams-label">{team.label}</span>
                {team.orgName ? <span className="n-teams-org">{team.orgName}</span> : null}
              </span>
              {team.active ? <span className="n-teams-current">Current</span> : null}
              <FontAwesomeIcon aria-hidden="true" className="n-teams-chevron" icon={faChevronRight} />
            </a>
          </li>
        ))}
      </ul>
    </section>
  )
}

/**
 * Asks the API once, after first paint, and never blocks the page: until an
 * answer with at least one team arrives there is nothing in the DOM.
 */
export const SignedInTeams = ({ apiOrigin }: { apiOrigin: string }) => {
  const [teams, setTeams] = useState<LandingTeam[]>([])

  useEffect(() => {
    const controller = new AbortController()
    void fetchLandingTeams({ apiOrigin, signal: controller.signal }).then((next) => {
      if (!controller.signal.aborted) setTeams(next)
    })
    return () => controller.abort()
  }, [apiOrigin])

  return <SignedInTeamsSection teams={teams} />
}
