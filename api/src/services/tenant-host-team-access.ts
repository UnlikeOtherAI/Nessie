import type { PrismaClient } from '@prisma/client'
import type { UoaSessionIdentity } from '@nessie/schemas'

import {
  deriveUoaTeamDirectoryFromTeams,
  readUoaTeamDirectory,
} from './uoa-directory-cache.js'
import {
  refreshStaleUoaTeamDirectory,
  type UoaDirectoryRefreshDeps,
} from './uoa-directory-refresh.js'

/**
 * Whether this person may be told which team a hostname is.
 *
 * `/api/hosts/resolve` is public and answers about the **organisation**; a
 * guessable label reveals nothing there that the hostname did not. Its
 * authenticated sibling `/api/hosts/team` answers about the **team**, and
 * docs/standards/team-hosts.md is explicit that a team address must never name
 * its team to somebody who has not been let in — that rule is the entire
 * reason the two are split.
 *
 * Being signed in was standing in for having been let in, and those are not
 * the same thing. Any account on the instance could walk
 * `<guess>.<org>.<base>` and learn, per guess, whether that team exists and
 * what its UOA ids are.
 *
 * **This is a disclosure gate, not an authorization one.** The ids it guards
 * grant nothing: the switch behind them (`POST /api/auth/uoa/team`) re-resolves
 * membership live with UOA and fails closed. So the bounded directory is the
 * right source here even though it would not be for a grant — the worst a
 * stale entry does is let somebody who was removed in the last minute confirm
 * a team they were in a minute ago, and their switch is still refused.
 *
 * It fails closed everywhere it cannot answer: no UOA identity, no directory,
 * an empty one. The cold-cache fallback is the person's own `TeamMember` rows,
 * which is membership by construction.
 */
export const actorHoldsUoaTeam = async (
  prisma: PrismaClient,
  input: {
    identity: UoaSessionIdentity | undefined
    /** The local organisation of the session's active team. */
    organizationId: string
    team: { externalOrgId: string; externalTeamId: string }
    userId: string
  },
  deps: UoaDirectoryRefreshDeps = {},
): Promise<boolean> => {
  // A team hostname is only meaningful for a UOA session: the ids exist to run
  // a UOA team switch, which refuses every other kind of session outright.
  if (!input.identity) return false

  try {
    // The same bounded read `/api/auth/me` does, and on a cold load of a team
    // host it is the same page load — one in-flight refresh per user collapses
    // them, and a 60 s cooldown bounds the rest. Freshness is an improvement
    // on the cached answer, never a precondition for it.
    await refreshStaleUoaTeamDirectory(prisma, {
      identity: input.identity,
      organizationId: input.organizationId,
      userId: input.userId,
    }, deps)
  } catch {
    // A refusal to refresh must not become a refusal to answer for somebody
    // whose cached directory already says they are in this team.
  }

  const directory = readUoaTeamDirectory(input.userId)
    ?? await deriveUoaTeamDirectoryFromTeams(prisma, input.userId)

  return directory.entries.some((entry) =>
    entry.organizationId === input.team.externalOrgId
    && entry.teamId === input.team.externalTeamId)
}
