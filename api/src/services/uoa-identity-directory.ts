import type { UoaSessionIdentity, TeamMemberRecord } from '@nessie/schemas'

import {
  listOrganisationMembers,
  UoaRosterUnavailableError,
  withUoaOrgRosterSubjectAssertion,
  type UoaRosterDeps,
  type UoaRosterListQuery,
  type UoaRosterPage,
} from './uoa-org-roster.js'
import { createLiveOrganizationCache, liveCacheKey } from './uoa-live-cache.js'

const DEFAULT_TTL_MS = 30_000
const DEFAULT_MAX_ENTRIES = 100
const DEFAULT_MAX_CACHED_MEMBERS = 20_000
const DEFAULT_MAX_IN_FLIGHT = 20
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
  maxInFlight?: number
  now?: () => number
  rosterDeps?: UoaRosterDeps
  ttlMs?: number
}

type LoadDirectoryPage = NonNullable<UoaIdentityDirectoryOptions['loadPage']>

const copyMembers = (members: readonly TeamMemberRecord[]): TeamMemberRecord[] =>
  members.map((member) => ({ ...member }))

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
 * and an upstream failure never serves stale identity or membership data. The
 * cache itself is the shared one (`uoa-live-cache.ts`), which states those
 * rules once for every relayed identity read.
 */
export const createUoaIdentityDirectory = (
  options: UoaIdentityDirectoryOptions = {},
): UoaIdentityDirectory => {
  const loadPage: LoadDirectoryPage = options.loadPage ?? defaultLoadPage(options.rosterDeps ?? {})
  const cache = createLiveOrganizationCache<TeamMemberRecord[]>({
    copy: copyMembers,
    maxEntries: options.maxEntries ?? DEFAULT_MAX_ENTRIES,
    maxInFlight: options.maxInFlight ?? DEFAULT_MAX_IN_FLIGHT,
    maxWeight: options.maxCachedMembers ?? DEFAULT_MAX_CACHED_MEMBERS,
    ...(options.now ? { now: options.now } : {}),
    overloaded: () => new UoaRosterUnavailableError(
      '[uoa] too many organization directory reads are already in progress',
    ),
    ttlMs: options.ttlMs ?? DEFAULT_TTL_MS,
    weigh: (members) => members.length,
  })

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
    list: (input) => cache.read(
      liveCacheKey(input.externalOrgId, input.identity),
      input.externalOrgId,
      () => loadAll(input),
    ),
    invalidateOrganization: (externalOrgId) => cache.invalidateOrganization(externalOrgId),
  }
}

export const uoaIdentityDirectory = createUoaIdentityDirectory()
