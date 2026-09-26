import type { PersonTeam, TeamMemberRecord, UoaSessionIdentity } from '@nessie/schemas'

import { createLiveOrganizationCache, liveCacheKey } from './uoa-live-cache.js'
import {
  listTeamMembers,
  UoaRosterRejectedError,
  UoaRosterUnavailableError,
  withUoaRosterSubjectAssertion,
  type UoaRosterDeps,
  type UoaRosterListQuery,
  type UoaRosterPage,
} from './uoa-org-roster.js'

/**
 * Which teams each person is in, on an organisation bound to the sign-in
 * provider — the "teams" column of the People roster.
 *
 * The provider's organisation roster carries no teams, so the answer is the
 * organisation's team rosters read one by one, with the asker's own subject
 * assertion: the provider decides, per team, whether this person may read it,
 * and a team they may not read adds nothing rather than failing the rest.
 * Nothing is stored. The result is held in process memory for 30 seconds in
 * the shared live cache, keyed by the asker and the team list, and every
 * roster write drops it (`invalidateOrganization`).
 */

const DEFAULT_TTL_MS = 30_000
const DEFAULT_MAX_ENTRIES = 100
const DEFAULT_MAX_MEMBERSHIPS = 50_000
const DEFAULT_MAX_IN_FLIGHT = 20
const MAX_TEAMS = 100
const PAGE_SIZE = 100
const MAX_PAGES_PER_TEAM = 50
// The team rosters are read a few at a time: all at once would be a burst the
// provider rate-limits, one at a time a wait the reader sees.
const TEAM_READ_CONCURRENCY = 4

/** A local team bound to a provider team — the only kind a relayed roster can name. */
export type BoundTeam = {
  externalTeamId: string
  id: string
  name: string
}

export type UoaTeamMembershipInput = {
  externalOrgId: string
  identity: UoaSessionIdentity
  teams: readonly BoundTeam[]
}

type TeamPage = UoaRosterPage<TeamMemberRecord, unknown>

export type UoaTeamMembershipOptions = {
  loadPage?: (
    input: { externalOrgId: string; externalTeamId: string; identity: UoaSessionIdentity },
    query: UoaRosterListQuery,
  ) => Promise<TeamPage>
  maxEntries?: number
  maxInFlight?: number
  maxMemberships?: number
  now?: () => number
  rosterDeps?: UoaRosterDeps
  ttlMs?: number
}

export type UoaTeamMembershipDirectory = {
  /** Each provider subject's teams among `teams`, as far as the asker may read them. */
  membershipsBySubject(input: UoaTeamMembershipInput): Promise<Map<string, PersonTeam[]>>
  invalidateOrganization(externalOrgId: string): void
}

type Memberships = Map<string, PersonTeam[]>

const copyMemberships = (memberships: Memberships): Memberships =>
  new Map([...memberships].map(([subject, teams]) => [subject, teams.map((team) => ({ ...team }))]))

const weigh = (memberships: Memberships): number =>
  [...memberships.values()].reduce((total, teams) => total + teams.length, 0)

/** A roster the asker may not read is theirs to miss, not an outage. */
const isRefusal = (error: unknown): boolean =>
  error instanceof UoaRosterRejectedError && (error.statusCode === 403 || error.statusCode === 404)

export const createUoaTeamMembershipDirectory = (
  options: UoaTeamMembershipOptions = {},
): UoaTeamMembershipDirectory => {
  const rosterDeps = options.rosterDeps ?? {}
  const loadPage = options.loadPage ?? (async (input, query) =>
    listTeamMembers(
      { externalOrgId: input.externalOrgId, externalTeamId: input.externalTeamId },
      query,
      withUoaRosterSubjectAssertion(
        { externalOrgId: input.externalOrgId, externalTeamId: input.externalTeamId },
        input.identity,
        rosterDeps,
      ),
    ))
  const cache = createLiveOrganizationCache<Memberships>({
    copy: copyMemberships,
    maxEntries: options.maxEntries ?? DEFAULT_MAX_ENTRIES,
    maxInFlight: options.maxInFlight ?? DEFAULT_MAX_IN_FLIGHT,
    maxWeight: options.maxMemberships ?? DEFAULT_MAX_MEMBERSHIPS,
    ...(options.now ? { now: options.now } : {}),
    overloaded: () => new UoaRosterUnavailableError(
      '[uoa] too many team membership reads are already in progress',
    ),
    ttlMs: options.ttlMs ?? DEFAULT_TTL_MS,
    weigh,
  })

  /** One team's members, every page; null when the asker may not read it. */
  const readTeam = async (
    input: UoaTeamMembershipInput,
    team: BoundTeam,
  ): Promise<TeamMemberRecord[] | null> => {
    const members: TeamMemberRecord[] = []
    const seenCursors = new Set<string>()
    let cursor: string | undefined
    try {
      for (let pageNumber = 0; pageNumber < MAX_PAGES_PER_TEAM; pageNumber += 1) {
        const page = await loadPage(
          { externalOrgId: input.externalOrgId, externalTeamId: team.externalTeamId, identity: input.identity },
          // Every lifecycle but removed: a deactivated person's teams still
          // show on the Deactivated roster, where reactivating is decided.
          { limit: PAGE_SIZE, status: 'all', ...(cursor ? { cursor } : {}) },
        )
        members.push(...page.items)
        if (!page.meta.hasMore) return members
        const nextCursor = page.meta.nextCursor ?? undefined
        if (!nextCursor || seenCursors.has(nextCursor)) {
          throw new UoaRosterUnavailableError('[uoa] a team roster returned an incomplete page cursor')
        }
        seenCursors.add(nextCursor)
        cursor = nextCursor
      }
    } catch (error) {
      if (isRefusal(error)) return null
      throw error
    }
    throw new UoaRosterUnavailableError(
      `[uoa] a team roster exceeded ${MAX_PAGES_PER_TEAM * PAGE_SIZE} members`,
    )
  }

  const loadAll = async (input: UoaTeamMembershipInput): Promise<Memberships> => {
    if (input.teams.length > MAX_TEAMS) {
      throw new UoaRosterUnavailableError(`[uoa] the organisation has more than ${MAX_TEAMS} teams`)
    }
    const memberships: Memberships = new Map()
    for (let start = 0; start < input.teams.length; start += TEAM_READ_CONCURRENCY) {
      const batch = input.teams.slice(start, start + TEAM_READ_CONCURRENCY)
      const rosters = await Promise.all(batch.map((team) => readTeam(input, team)))
      batch.forEach((team, index) => {
        for (const member of rosters[index] ?? []) {
          if (member.status === 'REMOVED') continue
          const teams = memberships.get(member.uoaSub) ?? []
          teams.push({ id: team.id, name: team.name, ...(member.teamRole ? { role: member.teamRole } : {}) })
          memberships.set(member.uoaSub, teams)
        }
      })
    }
    for (const teams of memberships.values()) teams.sort((left, right) => left.name.localeCompare(right.name))
    return memberships
  }

  return {
    membershipsBySubject: (input) => {
      // The team list is part of the key: a team materialised, renamed or
      // removed locally is a different question.
      const teamsKey = [...input.teams]
        .map((team) => `${team.id}:${team.externalTeamId}:${team.name}`)
        .sort()
        .join('\u0001')
      return cache.read(
        liveCacheKey(input.externalOrgId, input.identity, teamsKey),
        input.externalOrgId,
        () => loadAll(input),
      )
    },
    invalidateOrganization: (externalOrgId) => cache.invalidateOrganization(externalOrgId),
  }
}

export const uoaTeamMembershipDirectory = createUoaTeamMembershipDirectory()
