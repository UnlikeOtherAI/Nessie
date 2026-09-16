import { faChevronRight } from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { useState } from 'react'

import { type LandingTeam } from './landing-teams'
import { useLandingTeams } from './use-landing-teams'

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
      <h2 className="n-teams-title" id="n-teams-title">You’re signed in</h2>
      <p className="n-teams-lede">
        Open one of your teams to pick up where you left off — or keep reading.
      </p>
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
 * Reads the shared answer rather than asking again: the header needs the same
 * one, and two fetches would disagree for a moment and cost every anonymous
 * visitor a second credentialed request.
 */
export const SignedInTeams = () => {
  const { teams } = useLandingTeams()
  return <SignedInTeamsSection teams={teams} />
}
