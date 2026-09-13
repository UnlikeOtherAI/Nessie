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
 * **One bounded exception, and it is the only one.** A pending team invitation
 * also becomes a durable `UserAlert` row carrying its `teamName` and
 * `invitedBy` (`services/team-invite-alerts.ts`), because a notification a
 * person has not opened yet has to survive the process that learned about it —
 * an in-memory copy would make the bell empty on every replica but one. The
 * exception is safe only because it is self-reconciling: `syncTeamInviteAlerts`
 * rewrites the row from each verified directory and *deletes* every invitation
 * UOA no longer lists, so the copy cannot outlive the invitation, and nothing
 * reads it as authority — accepting or declining happens at UOA. Anything else
 * UOA-owned still belongs here and nowhere else (2026-09-05 review, FO2-5).
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

/**
 * How long a cached directory is treated as current by an on-demand read.
 *
 * The TTL above is how long a copy may be *kept*; this is how long it may be
 * *believed* without asking UOA again. They are different questions and the
 * 30-minute answer is wrong for the second one: an invitation created for a
 * signed-in person, or a membership accepted out of band through a mail link,
 * was invisible in an open session for up to half an hour — a full page reload
 * included — because `/api/auth/me` served the cached copy and nothing
 * refreshed it. `services/uoa-directory-refresh.ts` re-reads `/org/me` when the
 * copy is older than this and keeps the 30-minute copy when that read fails.
 *
 * It is also the cooldown between *attempts*, which is not the same thing. A
 * failed read leaves the cached copy's `storedAt` untouched, so without a
 * separate attempt stamp a stale copy plus an unreachable UOA would put a fresh
 * 10-second upstream timeout on every single sequential `/api/auth/me` — the
 * single-flight guard only collapses calls that overlap in time.
 */
export const DIRECTORY_FRESH_MS = 60 * 1000

/** Hard bound on cached users. The oldest read/write is evicted past it. */
const DIRECTORY_MAX_USERS = 10_000

type CachedDirectory = {
  directory: UoaTeamDirectory
  expiresAt: number
  storedAt: number
}

export type UoaTeamDirectoryFallback = {
  entries: UoaTeamDirectoryEntry[]
  pendingInvites: undefined
}

// Insertion-ordered Map used as the LRU: every hit and every write re-inserts
// the key at the end, so the first key is always the least recently used.
const directoryByUserId = new Map<string, CachedDirectory>()

/**
 * When this user's next on-demand refresh attempt is allowed, as an absolute
 * timestamp. Separate from the directory entry above because the case that
 * needs it hardest — a cold cache on a replica that cannot reach UOA — has no
 * directory entry to stamp. Same insertion-ordered LRU and the same cap.
 */
const refreshCooldownByUserId = new Map<string, number>()

const setRefreshCooldown = (userId: string, until: number): void => {
  refreshCooldownByUserId.delete(userId)
  refreshCooldownByUserId.set(userId, until)
  while (refreshCooldownByUserId.size > DIRECTORY_MAX_USERS) {
    const oldest = refreshCooldownByUserId.keys().next()
    if (oldest.done) break
    refreshCooldownByUserId.delete(oldest.value)
  }
}

/**
 * May an on-demand refresh ask UOA for this user right now?
 *
 * False during the cooldown a previous *attempt* started, whether that attempt
 * succeeded, failed, or was refused. The cached copy is served either way.
 */
export const mayAttemptUoaDirectoryRefresh = (
  userId: string,
  now: number = Date.now(),
): boolean => {
  const until = refreshCooldownByUserId.get(userId)
  if (until === undefined) return true
  if (until <= now) {
    refreshCooldownByUserId.delete(userId)
    return true
  }
  return false
}

/**
 * Record that a refresh is being attempted now. Called before the request, so a
 * read that fails or hangs still costs at most one upstream call per cooldown.
 */
export const noteUoaDirectoryRefreshAttempt = (
  userId: string,
  now: number = Date.now(),
): void => {
  setRefreshCooldown(userId, now + DIRECTORY_FRESH_MS)
}

/**
 * Stop attempting on-demand refreshes for this user until something writes a
 * verified directory again (a login or a token rotation), or until the cached
 * copy would have expired anyway.
 *
 * This is for UOA *refusing* the subject assertion — 401/403, meaning the epoch
 * advanced or the account was deactivated. Retrying that every minute cannot
 * succeed: only a new session can. The cached copy is deliberately kept rather
 * than evicted, which is what this path did before the on-demand read existed.
 */
export const suppressUoaDirectoryRefreshUntilVerifiedRead = (
  userId: string,
  now: number = Date.now(),
): void => {
  const cached = directoryByUserId.get(userId)
  setRefreshCooldown(
    userId,
    cached && cached.expiresAt > now ? cached.expiresAt : now + DIRECTORY_TTL_MS,
  )
}

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
  // A verified directory ends any attempt cooldown, including the long one a
  // refused assertion set: a login or rotation getting this far IS the new
  // session that suppression was waiting for.
  refreshCooldownByUserId.delete(userId)
  directoryByUserId.delete(userId)
  directoryByUserId.set(userId, {
    directory,
    expiresAt: now + DIRECTORY_TTL_MS,
    storedAt: now,
  })
  while (directoryByUserId.size > DIRECTORY_MAX_USERS) {
    const oldest = directoryByUserId.keys().next()
    if (oldest.done) break
    directoryByUserId.delete(oldest.value)
  }
}

/**
 * How long ago this user's cached directory was verified, or `undefined` when
 * the cache is cold or the entry has expired. Reading the age does not count as
 * a use: it deliberately leaves the LRU order alone, so a freshness probe on
 * every `/api/auth/me` cannot keep an otherwise idle entry alive.
 */
export const readUoaTeamDirectoryAge = (
  userId: string,
  now: number = Date.now(),
): number | undefined => {
  const cached = directoryByUserId.get(userId)
  if (!cached || cached.expiresAt <= now) return undefined
  return Math.max(0, now - cached.storedAt)
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
  // Forgetting exists so the next read re-asks UOA; leaving a cooldown behind
  // would be the one thing that stops it.
  refreshCooldownByUserId.delete(userId)
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
  refreshCooldownByUserId.clear()
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
