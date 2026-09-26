import type { Prisma, PrismaClient } from '@prisma/client'
import {
  buildPage,
  decodeKeysetCursor,
  resolvePageLimit,
  type LocalPerson,
  type PaginationDirection,
  type PaginationMeta,
  type PeopleStatus,
  type PersonTeam,
} from '@nessie/schemas'
import { organizationTeamsWhere } from '@nessie/team-admin'

/**
 * The people read model on an install with no sign-in provider: the install is
 * the authority for its own people (`docs/standards/team-model.md`, the unbound
 * organisation), so the roster is its `OrganizationMember` and `TeamMember`
 * rows. A bound organisation never reaches here — its roster is relayed
 * (`routes/people.ts`), because there these rows are a projection, not the
 * authority.
 */

export type LocalRosterPageQuery = {
  cursor?: string
  direction?: PaginationDirection
  limit?: number
  status: PeopleStatus
}

type LocalRosterPage = { items: LocalPerson[]; meta: PaginationMeta }

/** One of the organisation's own teams — never a system team or another organisation's. */
export type OrganizationTeam = { externalOrgId: string | null; externalTeamId: string | null; id: string; name: string }

export const findOrganizationTeam = async (
  prisma: PrismaClient,
  organizationId: string,
  teamId: string,
): Promise<OrganizationTeam | null> =>
  prisma.team.findFirst({
    where: { id: teamId, ...organizationTeamsWhere(organizationId) },
    select: { externalOrgId: true, externalTeamId: true, id: true, name: true },
  })

/** The organisation's teams that are the provider's too — the only ones a relayed roster can name. */
export const listBoundOrganizationTeams = async (
  prisma: PrismaClient,
  organizationId: string,
): Promise<Array<{ externalTeamId: string; id: string; name: string }>> => {
  const teams = await prisma.team.findMany({
    where: { ...organizationTeamsWhere(organizationId), externalTeamId: { not: null } },
    select: { externalTeamId: true, id: true, name: true },
    orderBy: { name: 'asc' },
  })
  return teams.flatMap((team) => (team.externalTeamId ? [{ ...team, externalTeamId: team.externalTeamId }] : []))
}

/** Each person's teams in this organisation, with their role in each, by user id. */
const teamsByUser = async (
  prisma: PrismaClient,
  organizationId: string,
  userIds: readonly string[],
): Promise<Map<string, PersonTeam[]>> => {
  const byUser = new Map<string, PersonTeam[]>()
  if (userIds.length === 0) return byUser
  const memberships = await prisma.teamMember.findMany({
    where: { team: organizationTeamsWhere(organizationId), userId: { in: [...userIds] } },
    select: { role: true, team: { select: { id: true, name: true } }, userId: true },
  })
  for (const membership of memberships) {
    const teams = byUser.get(membership.userId) ?? []
    teams.push({ id: membership.team.id, name: membership.team.name, role: membership.role })
    byUser.set(membership.userId, teams)
  }
  for (const teams of byUser.values()) teams.sort((left, right) => left.name.localeCompare(right.name))
  return byUser
}

/**
 * Keyset over `(createdAt, id)` ascending — who joined first, first — with the
 * shared page contract, so the admin's pager reads it like every other list.
 */
const keysetWhere = <T>(base: T, query: LocalRosterPageQuery): T | { AND: unknown[] } => {
  const cursor = decodeKeysetCursor(query.cursor)
  if (!cursor) return base
  const operator = query.direction === 'backward' ? 'lt' : 'gt'
  return {
    AND: [
      base,
      {
        OR: [
          { createdAt: { [operator]: cursor.createdAt } },
          { createdAt: cursor.createdAt, id: { [operator]: cursor.id } },
        ],
      },
    ],
  }
}

const keysetOrder = (query: LocalRosterPageQuery) =>
  query.direction === 'backward'
    ? [{ createdAt: 'desc' as const }, { id: 'desc' as const }]
    : [{ createdAt: 'asc' as const }, { id: 'asc' as const }]

const PERSON_SELECT = {
  avatarAttachmentId: true,
  avatarUrl: true,
  displayName: true,
  email: true,
  id: true,
} as const

type PersonRow = {
  avatarAttachmentId: string | null
  avatarUrl: string | null
  displayName: string
  email: string
  id: string
}

const toLocalPerson = (
  user: PersonRow,
  membership: { deactivatedAt: Date | null; role: string },
  teams: PersonTeam[],
  teamRole?: string,
): LocalPerson => ({
  ...(user.avatarAttachmentId ? { avatarAttachmentId: user.avatarAttachmentId } : {}),
  ...(user.avatarUrl ? { avatarUrl: user.avatarUrl } : {}),
  displayName: user.displayName,
  email: user.email,
  orgRole: membership.role,
  status: membership.deactivatedAt ? 'DEACTIVATED' : 'ACTIVE',
  ...(teamRole ? { teamRole } : {}),
  teams,
  userId: user.id,
})

/** The organisation's people, active or deactivated, each with their teams. */
export const listLocalOrganizationPeople = async (
  prisma: PrismaClient,
  organizationId: string,
  query: LocalRosterPageQuery,
): Promise<LocalRosterPage> => {
  const limit = resolvePageLimit(query.limit)
  const where: Prisma.OrganizationMemberWhereInput = {
    deactivatedAt: query.status === 'DEACTIVATED' ? { not: null } : null,
    organizationId,
  }
  const total = await prisma.organizationMember.count({ where })
  const rows = await prisma.organizationMember.findMany({
    include: { user: { select: PERSON_SELECT } },
    orderBy: keysetOrder(query),
    take: limit + 1,
    where: keysetWhere(where, query) as Prisma.OrganizationMemberWhereInput,
  })
  const page = buildPage({
    direction: query.direction,
    hasCursor: Boolean(decodeKeysetCursor(query.cursor)),
    limit,
    rows,
    total,
  })
  const teams = await teamsByUser(prisma, organizationId, page.data.map((row) => row.userId))
  return {
    items: page.data.map((row) => toLocalPerson(row.user, row, teams.get(row.userId) ?? [])),
    meta: page.meta,
  }
}

/** One team's people: its members whose organisation membership has this status. */
export const listLocalTeamPeople = async (
  prisma: PrismaClient,
  organizationId: string,
  teamId: string,
  query: LocalRosterPageQuery,
): Promise<LocalRosterPage> => {
  const limit = resolvePageLimit(query.limit)
  const where: Prisma.TeamMemberWhereInput = {
    teamId,
    user: {
      organizationMembers: {
        some: {
          deactivatedAt: query.status === 'DEACTIVATED' ? { not: null } : null,
          organizationId,
        },
      },
    },
  }
  const total = await prisma.teamMember.count({ where })
  const rows = await prisma.teamMember.findMany({
    include: {
      user: {
        select: {
          ...PERSON_SELECT,
          organizationMembers: {
            select: { deactivatedAt: true, role: true },
            where: { organizationId },
          },
        },
      },
    },
    orderBy: keysetOrder(query),
    take: limit + 1,
    where: keysetWhere(where, query) as Prisma.TeamMemberWhereInput,
  })
  const page = buildPage({
    direction: query.direction,
    hasCursor: Boolean(decodeKeysetCursor(query.cursor)),
    limit,
    rows,
    total,
  })
  const teams = await teamsByUser(prisma, organizationId, page.data.map((row) => row.userId))
  return {
    items: page.data.flatMap((row) => {
      const membership = row.user.organizationMembers[0]
      return membership
        ? [toLocalPerson(row.user, membership, teams.get(row.userId) ?? [], row.role)]
        : []
    }),
    meta: page.meta,
  }
}

/** Whether this person is in the team — who, besides an administrator, may read its roster. */
export const isLocalTeamMember = async (
  prisma: PrismaClient,
  teamId: string,
  userId: string,
): Promise<boolean> =>
  (await prisma.teamMember.count({ where: { teamId, userId } })) > 0
