import type { UoaSessionIdentity, TeamMemberRecord } from '@nessie/schemas'

import {
  listOrganisationMembers,
  UoaRosterUnavailableError,
  withUoaOrgRosterSubjectAssertion,
  type UoaRosterDeps,
  type UoaRosterListQuery,
  type UoaRosterPage,
} from './uoa-org-roster.js'

const DEFAULT_TTL_MS = 30_000
const DEFAULT_MAX_ENTRIES = 100
const DEFAULT_MAX_CACHED_MEMBERS = 20_000
const PAGE_SIZE = 100
const MAX_PAGES = 50

type DirectoryPage = UoaRosterPage<TeamMemberRecord, unknown>

export type UoaIdentityDirectoryInput = {
  externalOrgId: string
  identity: UoaSessionIdentity
}

export type UoaIdentityDirectory = {
  list(input: UoaIdentityDirectoryInput): Promise<TeamMemberRecord[]>
  invalidateOrganization(externalOrgId: string): void
}

export type UoaIdentityDirectoryOptions = {
  loadPage?: (
    input: UoaIdentityDirectoryInput,
    query: UoaRosterListQuery,
  ) => Promise<DirectoryPage>
  maxCachedMembers?: number
  maxEntries?: number
  now?: () => number
  rosterDeps?: UoaRosterDeps
  ttlMs?: number
}

type LoadDirectoryPage = NonNullable<UoaIdentityDirectoryOptions['loadPage']>

type CacheEntry = {
  expiresAt: number
  externalOrgId: string
  members: TeamMemberRecord[]
}

const copyMembers = (members: readonly TeamMemberRecord[]): TeamMemberRecord[] =>
  members.map((member) => ({ ...member }))

const cacheKey = (input: UoaIdentityDirectoryInput): string => [
  input.externalOrgId,
  input.identity.subject,
  input.identity.teamId,
  input.identity.tokenVersion,
].join('\u0000')

const defaultLoadPage = (
  rosterDeps: UoaRosterDeps,
): LoadDirectoryPage => async (input, query) =>
  listOrganisationMembers(
    input.externalOrgId,
    query,
    withUoaOrgRosterSubjectAssertion(input.externalOrgId, input.identity, rosterDeps),
  )

/**
 * The live UOA identity directory used by legacy product-person selectors.
 *
 * Entries are scoped to the exact acting subject, organisation, active team,
 * and credential epoch. They are display data only: no authorization decision
 * may read this cache. An expired entry is discarded before the upstream read,
 * and an upstream failure never serves stale identity or membership data.
 */
export const createUoaIdentityDirectory = (
  options: UoaIdentityDirectoryOptions = {},
): UoaIdentityDirectory => {
  const now = options.now ?? Date.now
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES
  const maxCachedMembers = options.maxCachedMembers ?? DEFAULT_MAX_CACHED_MEMBERS
  const loadPage: LoadDirectoryPage = options.loadPage ?? defaultLoadPage(options.rosterDeps ?? {})
  const cache = new Map<string, CacheEntry>()
  let cachedMemberCount = 0

  const deleteCached = (key: string): void => {
    const cached = cache.get(key)
    if (!cached) return
    cachedMemberCount -= cached.members.length
    cache.delete(key)
  }

  const loadAll = async (input: UoaIdentityDirectoryInput): Promise<TeamMemberRecord[]> => {
    const members = new Map<string, TeamMemberRecord>()
    const seenCursors = new Set<string>()
    let cursor: string | undefined

    for (let pageNumber = 0; pageNumber < MAX_PAGES; pageNumber += 1) {
      const page = await loadPage(input, {
        limit: PAGE_SIZE,
        // Product selectors may offer only people UOA currently places in the
        // organisation. Historical product records retain stable local author
        // references and are outside this active-person selector.
        status: 'ACTIVE',
        ...(cursor ? { cursor } : {}),
      })
      for (const member of page.items) {
        if (members.has(member.uoaSub)) {
          throw new UoaRosterUnavailableError(
            '[uoa] the organization directory repeated a subject',
          )
        }
        members.set(member.uoaSub, member)
      }
      if (!page.meta.hasMore) return copyMembers([...members.values()])

      const nextCursor = page.meta.nextCursor ?? undefined
      if (!nextCursor || seenCursors.has(nextCursor)) {
        throw new UoaRosterUnavailableError(
          '[uoa] the organization directory returned an incomplete page cursor',
        )
      }
      seenCursors.add(nextCursor)
      cursor = nextCursor
    }

    throw new UoaRosterUnavailableError(
      `[uoa] the organization directory exceeded ${MAX_PAGES * PAGE_SIZE} members`,
    )
  }

  return {
    async list(input) {
      const key = cacheKey(input)
      const timestamp = now()
      const cached = cache.get(key)
      if (cached && cached.expiresAt > timestamp) {
        cache.delete(key)
        cache.set(key, cached)
        return copyMembers(cached.members)
      }
      deleteCached(key)

      const members = await loadAll(input)
      cache.set(key, {
        expiresAt: timestamp + ttlMs,
        externalOrgId: input.externalOrgId,
        members: copyMembers(members),
      })
      cachedMemberCount += members.length
      while (cache.size > maxEntries || cachedMemberCount > maxCachedMembers) {
        const oldest = cache.keys().next()
        if (oldest.done) break
        deleteCached(oldest.value)
      }
      return copyMembers(members)
    },

    invalidateOrganization(externalOrgId) {
      for (const [key, entry] of cache) {
        if (entry.externalOrgId === externalOrgId) deleteCached(key)
      }
    },
  }
}

export const uoaIdentityDirectory = createUoaIdentityDirectory()
