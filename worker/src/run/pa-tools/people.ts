import { Prisma } from '@prisma/client'
import { parseUserId, type TeamMemberRecord } from '@nessie/schemas'
import {
  listTeamMembers,
  resolveLocalUserIdsByUoaSub,
  resolveUoaRosterTeam,
  UoaRosterIdentityError,
  UoaRosterRejectedError,
  UoaRosterUnavailableError,
  withUoaRosterSubjectAssertion,
  type UoaRosterDeps,
  type UoaRosterTeam,
} from '@nessie/team-admin'
import type { BuiltinToolRuntimeContext, ToolExecutionResult } from '../tool-types.js'
import { requireActingUserId } from './access.js'
import { clampLimit, formatSection } from './tool-output.js'

/**
 * `people_search` mirrors what the Members page shows. On a UOA-linked team
 * the roster of record is UnlikeOtherAI's org API — the same
 * `listTeamMembers` read `GET /api/team/members` relays — and the
 * local user table answers only when the team is not UOA-linked (local mode).
 * A failed UOA read is reported in words, never silently answered from local
 * rows: a stale local list naming people UOA has removed is worse than an
 * honest error.
 */

const ROSTER_CACHE_TTL_MS = 60_000
const ROSTER_CACHE_MAX_ENTRIES = 50

type RosterCacheEntry = {
  expiresAt: number
  members: TeamMemberRecord[]
}

// Agent runs ask repeatedly within one conversation; one short-lived roster
// per (org, UOA org, UOA team) keeps that from becoming a UOA call per turn.
const rosterCache = new Map<string, RosterCacheEntry>()

export const clearPeopleSearchRosterCache = (): void => {
  rosterCache.clear()
}

const readRosterCached = async (
  organizationId: string,
  team: UoaRosterTeam,
  uoaSubject: string,
  deps: UoaRosterDeps,
): Promise<TeamMemberRecord[]> => {
  const key = `${organizationId}:${team.externalOrgId}:${team.externalTeamId}:${uoaSubject}`
  const cached = rosterCache.get(key)
  if (cached && cached.expiresAt > Date.now()) return cached.members
  const members = await listTeamMembers(team, deps)
  rosterCache.delete(key)
  if (rosterCache.size >= ROSTER_CACHE_MAX_ENTRIES) {
    const oldest = rosterCache.keys().next().value
    if (oldest !== undefined) rosterCache.delete(oldest)
  }
  rosterCache.set(key, { expiresAt: Date.now() + ROSTER_CACHE_TTL_MS, members })
  return members
}

const matchesQuery = (member: TeamMemberRecord, query: string): boolean =>
  (member.displayName ?? '').toLowerCase().includes(query)
  || (member.email ?? '').toLowerCase().includes(query)

const searchUoaRoster = async (
  context: BuiltinToolRuntimeContext,
  team: UoaRosterTeam,
  searchQuery: string,
  take: number,
  deps: UoaRosterDeps,
): Promise<ToolExecutionResult> => {
  let roster: TeamMemberRecord[]
  try {
    const subjectDeps = withUoaRosterSubjectAssertion(
      team,
      context.actorContext.actionContext.uoaIdentity,
      deps,
    )
    const subject = context.actorContext.actionContext.uoaIdentity?.subject
    if (!subject) throw new UoaRosterIdentityError('A current UnlikeOtherAI session is required.')
    roster = await readRosterCached(
      context.channel.organizationId,
      team,
      subject,
      subjectDeps,
    )
  } catch (error) {
    if (
      error instanceof UoaRosterUnavailableError
      || error instanceof UoaRosterRejectedError
      || error instanceof UoaRosterIdentityError
    ) {
      throw new Error(
        'The team roster lives in UnlikeOtherAI and could not be read '
        + `(${error.message}). The local user table is not the roster of `
        + 'record here, so no local answer is given — try again shortly.',
      )
    }
    throw error
  }

  const query = searchQuery.toLowerCase()
  const matched = roster
    .filter((member) => matchesQuery(member, query))
    .sort((a, b) =>
      (a.displayName ?? a.uoaSub).localeCompare(b.displayName ?? b.uoaSub))
    .slice(0, take)

  // Local rows keyed on the stable UOA subject (never email) so results carry
  // the `userId` that `send_message` and mentions take, when a linked row
  // exists — and so the caller's own row can say "(you)".
  //
  // Scoped to this organization by the shared resolver: `User.uoaSub` is
  // globally unique, so an unscoped lookup would hand this team a local
  // principal id for someone who only ever signed into a different one.
  const localIdBySub = await resolveLocalUserIdsByUoaSub(
    context.prisma,
    context.channel.organizationId,
    matched.map((member) => member.uoaSub),
  )
  const actingUserId = matched.length > 0 ? requireActingUserId(context) : null

  const lines = matched.map((member, index) => {
    const localUserId = localIdBySub.get(member.uoaSub)
    const youLabel = localUserId === actingUserId ? ' (you)' : ''
    const parts = [
      `uoaSub=${member.uoaSub}`,
      ...(localUserId ? [`userId=${localUserId}`] : []),
      `role=${member.teamRole ?? member.orgRole ?? 'member'}`,
      ...(member.status ? [`status=${member.status}`] : []),
    ]
    const name = member.displayName ?? member.uoaSub
    const email = member.email ? ` <${member.email}>` : ''
    return `${index + 1}. ${name}${youLabel}${email} | ${parts.join(' | ')}`
  })

  return {
    inputSummary: `query=${searchQuery}`,
    outputPreview:
      formatSection(`People (${lines.length}) — UnlikeOtherAI team roster`, lines)
      || `No people matched "${searchQuery}" in the UnlikeOtherAI team roster.`,
    toolName: 'people_search',
  }
}

const searchLocalUsers = async (
  context: BuiltinToolRuntimeContext,
  searchQuery: string,
  take: number,
): Promise<ToolExecutionResult> => {
  const people = await context.prisma.user.findMany({
    where: {
      organizationMembers: {
        some: { organizationId: context.channel.organizationId },
      },
      OR: [
        { displayName: { contains: searchQuery, mode: 'insensitive' } },
        { email: { contains: searchQuery, mode: 'insensitive' } },
      ],
    },
    orderBy: { displayName: 'asc' },
    select: {
      id: true,
      displayName: true,
      email: true,
      organizationMembers: {
        where: { organizationId: context.channel.organizationId },
        select: { role: true },
        take: 1,
      },
    },
    take,
  })

  const lines = people.map((person, index) => {
    const role = person.organizationMembers[0]?.role ?? 'member'
    const youLabel = person.id === requireActingUserId(context) ? ' (you)' : ''
    return `${index + 1}. ${person.displayName}${youLabel} <${person.email}> | userId=${person.id} | role=${role}`
  })

  return {
    inputSummary: `query=${searchQuery}`,
    outputPreview:
      formatSection(`People (${lines.length})`, lines) ||
      `No people matched "${searchQuery}".`,
    toolName: 'people_search',
  }
}

export const runPeopleSearchTool = async (
  context: BuiltinToolRuntimeContext,
  query: string,
  limit: unknown = 10,
  rosterDeps: UoaRosterDeps = {},
): Promise<ToolExecutionResult> => {
  const searchQuery = query.trim()
  if (!searchQuery) {
    throw new Error('query is required.')
  }
  const take = clampLimit(limit, 10)

  // Same resolution as GET /api/team/members: the run's channel names the
  // team, and only a team carrying both external ids on a deployment with UOA
  // credentials is UOA-linked. Null means local mode — the one case where the
  // local user table legitimately answers.
  const channel = await context.prisma.channel.findFirst({
    where: {
      id: context.channel.id,
      organizationId: context.channel.organizationId,
    },
    select: { teamId: true },
  })
  const team = await resolveUoaRosterTeam(context.prisma, {
    organizationId: context.channel.organizationId,
    teamId: channel?.teamId,
  })
  if (team) {
    return searchUoaRoster(context, team, searchQuery, take, rosterDeps)
  }
  return searchLocalUsers(context, searchQuery, take)
}

export const runUpdatePreferencesTool = async (
  context: BuiltinToolRuntimeContext,
  preferences: Record<string, unknown> | null,
): Promise<ToolExecutionResult> => {
  if (!preferences || Object.keys(preferences).length === 0) {
    throw new Error('preferences must be a non-empty object.')
  }

  const userId = requireActingUserId(context)
  const updatedUser = await context.prisma.user.update({
    where: { id: parseUserId(userId) },
    data: { preferences: preferences as Prisma.InputJsonValue },
    select: {
      id: true,
      preferences: true,
    },
  })

  return {
    inputSummary: 'preferences',
    outputPreview: `Updated preferences for userId=${updatedUser.id}\n${JSON.stringify(
      updatedUser.preferences ?? {},
    )}`,
    toolName: 'update_preferences',
  }
}
