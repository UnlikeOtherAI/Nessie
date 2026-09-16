// One answer to "is this visitor signed in, and to what", shared by the page.
//
// The teams rail used to ask on its own, which was fine while it was the only
// thing that cared. The header cares too: a page that can already name your
// teams has no business offering you a "Sign in" button. Two independent
// fetches would give the two of them different answers for a moment and put a
// second credentialed request on every anonymous page load, so the read
// happens once, here.
//
// Every failure — signed out, offline, a refused origin, an unexpected body —
// is an empty list, and an empty list renders nothing anywhere. Anonymous
// visitors are the overwhelming majority of this site's traffic and their page
// must not flash, so `settled` starts false and nothing that depends on the
// answer draws until it is true.
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'

import { fetchLandingTeams, type LandingTeam } from './landing-teams'

export type LandingTeamsState = {
  teams: readonly LandingTeam[]
  /** False until the API has answered; nothing signed-in-specific renders before. */
  settled: boolean
  signedIn: boolean
}

const signedOut: LandingTeamsState = { settled: false, signedIn: false, teams: [] }

/** Exported so a test can put the header in a state without a live fetch. */
export const LandingTeamsContext = createContext<LandingTeamsState>(signedOut)

export const LandingTeamsProvider = ({ apiOrigin, children }: {
  apiOrigin: string
  children: ReactNode
}) => {
  const [state, setState] = useState<LandingTeamsState>(signedOut)

  useEffect(() => {
    const controller = new AbortController()
    void fetchLandingTeams({ apiOrigin, signal: controller.signal }).then((teams) => {
      if (controller.signal.aborted) return
      setState({ settled: true, signedIn: teams.length > 0, teams })
    })
    return () => controller.abort()
  }, [apiOrigin])

  return <LandingTeamsContext.Provider value={state}>{children}</LandingTeamsContext.Provider>
}

export const useLandingTeams = (): LandingTeamsState => useContext(LandingTeamsContext)
