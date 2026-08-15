import type { PrismaClient } from '@prisma/client'

import type { UoaWorkspaceDirectoryEntry } from './uoa-workspace-directory.js'

/**
 * The UOA workspace directory (workspace labels, org ids/names, avatar URLs) is
 * UnlikeOtherAI-owned identity data. Nessie may keep it only in a bounded
 * in-memory cache that is never authoritative — never in a durable table — so
 * this module is the one place a directory lives between the UOA read that
 * produced it and the `/api/auth/me` response that renders it.
 *
 * Written wherever `fetchUoaWorkspaceDirectory` succeeds: at login
 * (`syncUoaProductAccountLinks`) and at every UOA token rotation, including a
 * workspace switch (`advanceUoaBindingInTransaction`). Read by
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
  entries: UoaWorkspaceDirectoryEntry[]
  expiresAt: number
}

// Insertion-ordered Map used as the LRU: every hit and every write re-inserts
// the key at the end, so the first key is always the least recently used.
const directoryByUserId = new Map<string, CachedDirectory>()

/**
 * Record a directory UOA just verified for this user. `undefined` means the
 * opportunistic UOA read failed, and — matching `fetchUoaWorkspaceDirectory`'s
 * contract — the last verified copy is kept for the lifetime of this process.
 */
export const rememberUoaWorkspaceDirectory = (
  userId: string,
  entries: UoaWorkspaceDirectoryEntry[] | undefined,
  now: number = Date.now(),
): void => {
  if (!entries) return
  directoryByUserId.delete(userId)
  directoryByUserId.set(userId, { entries, expiresAt: now + DIRECTORY_TTL_MS })
  while (directoryByUserId.size > DIRECTORY_MAX_USERS) {
    const oldest = directoryByUserId.keys().next()
    if (oldest.done) break
    directoryByUserId.delete(oldest.value)
  }
}

/** The cached directory for this user, or `undefined` when cold or expired. */
export const readUoaWorkspaceDirectory = (
  userId: string,
  now: number = Date.now(),
): UoaWorkspaceDirectoryEntry[] | undefined => {
  const cached = directoryByUserId.get(userId)
  if (!cached) return undefined
  if (cached.expiresAt <= now) {
    directoryByUserId.delete(userId)
    return undefined
  }
  directoryByUserId.delete(userId)
  directoryByUserId.set(userId, cached)
  return cached.entries
}

/** Test seam: drop every cached directory. */
export const clearUoaWorkspaceDirectoryCache = (): void => {
  directoryByUserId.clear()
}

/**
 * Degraded directory for a cold cache (fresh process, another replica), derived
 * **only** from data Nessie legitimately owns: the user's own `TeamMember` rows
 * joined to the `Team.externalWorkspaceId` / `externalOrgId` mapping written
 * when that UOA workspace was materialized locally. The team name stands in for
 * the UOA label and there is no org name; the avatar falls back to UOA's
 * deterministic per-team image URL at render time.
 *
 * Consequence, and the reason this is a fallback rather than a source: a
 * workspace the person is entitled to in UOA but has never opened in Nessie has
 * no local Team row, so it appears only once a rotation refreshes the real
 * directory into the cache.
 */
export const deriveUoaWorkspaceDirectoryFromTeams = async (
  prisma: PrismaClient,
  userId: string,
): Promise<UoaWorkspaceDirectoryEntry[]> => {
  const teams = await prisma.team.findMany({
    where: {
      externalOrgId: { not: null },
      externalWorkspaceId: { not: null },
      members: { some: { userId } },
    },
    orderBy: { name: 'asc' },
    select: { externalOrgId: true, externalWorkspaceId: true, name: true },
  })

  return teams.flatMap((team) => team.externalOrgId && team.externalWorkspaceId
    ? [{
        organizationId: team.externalOrgId,
        teamId: team.externalWorkspaceId,
        label: team.name,
      }]
    : [])
}
