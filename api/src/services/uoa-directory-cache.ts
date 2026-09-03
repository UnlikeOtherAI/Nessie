import type { PrismaClient } from '@prisma/client'

import type {
  UoaTeamDirectory,
  UoaTeamDirectoryEntry,
} from './uoa-team-directory.js'

/**
 * The UOA team directory (team labels, org ids/names, avatar URLs) is
 * UnlikeOtherAI-owned identity data. Nessie may keep it only in a bounded
 * in-memory cache that is never authoritative — never in a durable table — so
 * this module is the one place a directory lives between the UOA read that
 * produced it and the `/api/auth/me` response that renders it.
 *
 * Written wherever `fetchUoaTeamDirectory` succeeds: at login
 * (`syncUoaProductAccountLinks`) and at every UOA token rotation, including a
 * team switch (`advanceUoaBindingInTransaction`). Read by
 * `buildMeResponse`.
 *
 * The cache is per process. Multiple API replicas each keep their own, and each
 * repopulates from its own logins and rotations; a replica that has not yet seen
 * a rotation for a user serves the degraded local derivation below.
 */

/** Entries older than this are discarded; the next rotation re-reads UOA. */
const DIRECTORY_TTL_MS = 30 * 60 * 1000

/** Hard bound on cached users. The oldest read/write is evicted past it. */
const DIRECTORY_MAX_USERS = 10_000

type CachedDirectory = {
  directory: UoaTeamDirectory
  expiresAt: number
}

export type UoaTeamDirectoryFallback = {
  entries: UoaTeamDirectoryEntry[]
  pendingInvites: undefined
}

// Insertion-ordered Map used as the LRU: every hit and every write re-inserts
// the key at the end, so the first key is always the least recently used.
const directoryByUserId = new Map<string, CachedDirectory>()

/**
 * Record a directory UOA just verified for this user. `undefined` means the
 * opportunistic UOA read failed, and — matching `fetchUoaTeamDirectory`'s
 * contract — the last verified copy is kept for the lifetime of this process.
 */
export const rememberUoaTeamDirectory = (
  userId: string,
  directory: UoaTeamDirectory | undefined,
  now: number = Date.now(),
): void => {
  if (!directory) return
  directoryByUserId.delete(userId)
  directoryByUserId.set(userId, { directory, expiresAt: now + DIRECTORY_TTL_MS })
  while (directoryByUserId.size > DIRECTORY_MAX_USERS) {
    const oldest = directoryByUserId.keys().next()
    if (oldest.done) break
    directoryByUserId.delete(oldest.value)
  }
}

/** The cached directory for this user, or `undefined` when cold or expired. */
export const readUoaTeamDirectory = (
  userId: string,
  now: number = Date.now(),
): UoaTeamDirectory | undefined => {
  const cached = directoryByUserId.get(userId)
  if (!cached) return undefined
  if (cached.expiresAt <= now) {
    directoryByUserId.delete(userId)
    return undefined
  }
  directoryByUserId.delete(userId)
  directoryByUserId.set(userId, cached)
  return cached.directory
}

/**
 * Drop this user's cached directory so the next read re-asks UOA.
 *
 * Creating an organisation or a team is the case this exists for. The
 * happy path already re-primes, because the switch that follows creation is a
 * rotation and rotations write a freshly verified directory — but if that
 * switch fails, the person is left holding a directory that predates the thing
 * they just made, and the 30-minute TTL is a long time to be told your own new
 * team does not exist. Forgetting is safe at any moment: the entry is a
 * cache, and a miss falls back to a UOA read or the local team-derived
 * directory.
 */
export const forgetUoaTeamDirectory = (userId: string): void => {
  directoryByUserId.delete(userId)
}

/**
 * Rewrite one team's label in this user's cached directory after UOA has
 * accepted a rename.
 *
 * The cache holds only UOA-verified identity data, and this stays inside that
 * rule: the label written here is the one UOA echoed from the rename it just
 * stored, not a local guess. Forgetting the whole directory instead would also
 * show the new name — the cold-cache fallback derives labels from the freshly
 * mirrored `Team.name` — but it would drop this user's verified pending
 * invitations from the switcher until the next rotation, which is a visible
 * regression for a rename. Other members and other replicas keep their own
 * cached copy until their next rotation, exactly as they do for every other
 * UOA-side change.
 */
export const renameCachedUoaTeam = (
  userId: string,
  externalTeamId: string,
  label: string,
  now: number = Date.now(),
): void => {
  const cached = directoryByUserId.get(userId)
  if (!cached || cached.expiresAt <= now) return
  cached.directory = {
    ...cached.directory,
    entries: cached.directory.entries.map((entry) =>
      entry.teamId === externalTeamId ? { ...entry, label } : entry),
  }
}

/** Test seam: drop every cached directory. */
export const clearUoaTeamDirectoryCache = (): void => {
  directoryByUserId.clear()
}

/**
 * Degraded directory for a cold cache (fresh process, another replica), derived
 * **only** from data Nessie legitimately owns: the user's own `TeamMember` rows
 * joined to the `Team.externalTeamId` / `externalOrgId` mapping written
 * when that UOA team was materialized locally. The team name stands in for
 * the UOA label, and it is a healed mirror of it: `Team.name` is refreshed
 * from UOA's verified team directory by `syncExternalTeamNames`, so
 * once any verified `/org/me` read has occurred for that team the
 * fallback returns the real name rather than a frozen placeholder. The local
 * Organisation name is the permitted
 * non-authoritative mirror of UOA's `orgName`, so it is used only when present;
 * the avatar falls back to UOA's deterministic per-team image URL at render
 * time.
 *
 * Consequence, and the reason this is a fallback rather than a source: a
 * team the person is entitled to in UOA but has never opened in Nessie has
 * no local Team row, so it appears only once a rotation refreshes the real
 * directory into the cache.
 */
export const deriveUoaTeamDirectoryFromTeams = async (
  prisma: PrismaClient,
  userId: string,
): Promise<UoaTeamDirectoryFallback> => {
  const teams = await prisma.team.findMany({
    where: {
      externalOrgId: { not: null },
      externalTeamId: { not: null },
      members: { some: { userId } },
    },
    orderBy: { name: 'asc' },
    select: {
      externalOrgId: true,
      externalTeamId: true,
      name: true,
      project: { select: { organization: { select: { name: true } } } },
    },
  })

  return {
    entries: teams.flatMap((team) => team.externalOrgId && team.externalTeamId
      ? [{
        organizationId: team.externalOrgId,
        teamId: team.externalTeamId,
        label: team.name,
        orgName: team.project.organization.name,
      }]
      : []),
    // A cold cache has no verified invitation knowledge. `undefined` is
    // intentionally distinct from UOA having verified an empty list.
    pendingInvites: undefined,
  }
}
