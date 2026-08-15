import {
  listWorkspaceMembers,
  type UoaRosterDeps,
  type UoaRosterWorkspace,
} from './uoa-org-roster.js'

/**
 * "Is this UOA subject in this workspace's roster?" — the gate in front of the
 * subject-keyed avatar relay (`routes/workspace-members.ts`).
 *
 * The avatar relay is the full-trust domain-hash path: UOA will return an image
 * for **any** subject its domain knows, so without this check a member of one
 * workspace could read the picture of anybody in the whole UOA domain by
 * guessing subjects. The answer comes from the same roster read the Members
 * page is served from (`listWorkspaceMembers`) — never a second membership
 * source that could drift from what the page shows.
 *
 * The roster read is two `/org/*` calls, and a roster of N people renders N
 * avatars at once, so the subject set is cached briefly: bounded, in-memory,
 * per workspace. Entries hold the in-flight promise, so one page load asks UOA
 * once rather than once per row. The TTL is the staleness a removed member's
 * picture can survive for — seconds, not minutes.
 */

const TTL_MS = 30_000

// One entry per (UOA org, UOA team) actually being browsed. A deployment sees a
// handful; the bound only exists so a long-lived process cannot grow forever.
const MAX_WORKSPACES = 200

type CacheEntry = {
  expiresAt: number
  subjects: Promise<Set<string>>
}

const cache = new Map<string, CacheEntry>()

const cacheKey = (workspace: UoaRosterWorkspace): string =>
  `${workspace.externalOrgId}/${workspace.externalTeamId}`

const readSubjects = async (
  workspace: UoaRosterWorkspace,
  deps: UoaRosterDeps,
): Promise<Set<string>> => {
  const members = await listWorkspaceMembers(workspace, deps)
  return new Set(members.map((member) => member.uoaSub))
}

/** Drop the oldest insertion once the map is over its bound (Map keeps order). */
const evictOverflow = (): void => {
  while (cache.size > MAX_WORKSPACES) {
    const oldest = cache.keys().next()
    if (oldest.done) return
    cache.delete(oldest.value)
  }
}

/**
 * True when `uoaSub` appears in the workspace's roster. Throws whatever the
 * roster read throws (`UoaRosterUnavailableError` / `UoaRosterRejectedError`) —
 * an unreadable roster is never silently treated as "not a member", because the
 * caller must answer 502 rather than a misleading 404.
 */
export const isWorkspaceRosterSubject = async (
  workspace: UoaRosterWorkspace,
  uoaSub: string,
  deps: UoaRosterDeps = {},
): Promise<boolean> => {
  const key = cacheKey(workspace)
  const now = Date.now()
  const cached = cache.get(key)
  if (cached && cached.expiresAt > now) {
    return (await cached.subjects).has(uoaSub)
  }

  const entry: CacheEntry = { expiresAt: now + TTL_MS, subjects: readSubjects(workspace, deps) }
  cache.set(key, entry)
  evictOverflow()

  try {
    return (await entry.subjects).has(uoaSub)
  } catch (error) {
    // A failed read must not be remembered — the next request retries. Only
    // this entry is removed: a later attempt may already have replaced it.
    if (cache.get(key) === entry) cache.delete(key)
    throw error
  }
}

/** Forget every cached roster. Test seam — nothing in production calls it. */
export const clearWorkspaceRosterSubjectCache = (): void => {
  cache.clear()
}
