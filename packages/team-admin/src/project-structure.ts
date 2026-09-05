import type { PrismaClient } from '@prisma/client'
import {
  parseOrganizationId,
  parseProjectId,
  parseTeamId,
  type ProjectRecord,
  type TeamRecord,
} from '@nessie/schemas'

import { defaultBoardCreateData } from './board-structure.js'

/**
 * Project and team structure: the reads that resolve a name to an id, and the
 * writes that create one.
 *
 * `POST /api/projects` and `POST /api/teams` wrote their logic inline in the
 * route, so the Agent Designer had nothing to call — the worker cannot import
 * `api/src/services/*`. Rather than copy the board-column seeding and the owner
 * membership row into a second place, the operations live here and the routes
 * call them, exactly as channel/agent/trigger creation already do.
 *
 * Both writes are organisation-owner operations at every call site: the routes
 * gate with `requireOwner`, and the `project_create` / `team_create` tools gate
 * with `requireOwnerMember` against the live `OrganizationMember` row. The gate
 * is deliberately NOT inside these functions — bootstrap and team
 * provisioning create projects with no acting owner at all — so a new caller
 * must state its own authorization rather than inherit one silently.
 */

// The columns every project starts with. Historically in `api/src/services/board.ts`;
// it lives here because project creation is now shared with the worker and a
// project created from chat must get the same board a clicked one gets.
export const projectCountsInclude = {
  members: { select: { userId: true, role: true } },
  teams: { select: { _count: { select: { channels: true } } } },
} as const

type ProjectWithCounts = {
  id: string
  name: string
  avatarEmoji: string | null
  avatarAttachmentId: string | null
  organizationId: string
  createdAt: Date
  members: { userId: string; role: string }[]
  teams: { _count: { channels: number } }[]
}

export const mapProjectRecord = (project: ProjectWithCounts): ProjectRecord => ({
  id: parseProjectId(project.id),
  name: project.name,
  avatarEmoji: project.avatarEmoji,
  avatarAttachmentId: project.avatarAttachmentId,
  organizationId: parseOrganizationId(project.organizationId),
  memberCount: project.members.length,
  teamCount: project.teams.length,
  channelCount: project.teams.reduce((total, team) => total + team._count.channels, 0),
  createdAt: project.createdAt.toISOString(),
})

/**
 * Project read entitlement: an organisation owner sees every project in their
 * organisation; everybody else only the projects they are an explicit
 * `ProjectMember` of. `'all'` means "no project filter at all".
 *
 * This is the predicate behind `GET /api/projects`, the task list, the board
 * and the iterations routes. It is here so the `project_list` tool asks the
 * same question rather than a second one that could answer differently.
 */
export const listAccessibleProjectIds = async (
  prisma: PrismaClient,
  viewer: { isOwner: boolean; organizationId: string; userId: string },
): Promise<string[] | 'all'> => {
  if (viewer.isOwner) return 'all'
  const memberships = await prisma.projectMember.findMany({
    where: {
      userId: viewer.userId,
      project: { organizationId: viewer.organizationId },
    },
    select: { projectId: true },
  })
  return memberships.map((membership) => membership.projectId)
}

export const isProjectAccessibleToUser = async (
  prisma: PrismaClient,
  viewer: { isOwner: boolean; organizationId: string; userId: string },
  projectId: string,
): Promise<boolean> => {
  const project = await prisma.project.count({
    where: { id: projectId, organizationId: viewer.organizationId },
  })
  if (project === 0) return false
  if (viewer.isOwner) return true
  return (
    (await prisma.projectMember.count({
      where: { projectId, userId: viewer.userId },
    })) > 0
  )
}

/** The list `GET /api/projects` returns, scoped by the entitlement above. */
export const listProjectsForUser = async (
  prisma: PrismaClient,
  viewer: { isOwner: boolean; organizationId: string; userId: string },
): Promise<ProjectRecord[]> => {
  const accessible = await listAccessibleProjectIds(prisma, viewer)
  const projects = await prisma.project.findMany({
    where: {
      channelRoot: false,
      organizationId: viewer.organizationId,
      ...(accessible === 'all' ? {} : { id: { in: accessible } }),
    },
    include: projectCountsInclude,
    orderBy: { createdAt: 'asc' },
  })
  return projects.map(mapProjectRecord)
}

/**
 * The teams `GET /api/teams` returns: every non-system team in the caller's
 * organisation, optionally narrowed to one project. Team reads are org-wide
 * (the route carries only `requireActorContext`), so a caller narrowing this to
 * projects they can read — as `project_list` does — is strictly narrower.
 */
export const listTeamsForOrganization = async (
  prisma: PrismaClient,
  input: { organizationId: string; projectIds?: string[] },
): Promise<(TeamRecord & { memberCount: number })[]> => {
  const teams = await prisma.team.findMany({
    where: {
      project: { organizationId: input.organizationId },
      systemManaged: false,
      ...(input.projectIds ? { projectId: { in: input.projectIds } } : {}),
    },
    include: { members: { select: { userId: true } } },
    orderBy: { createdAt: 'asc' },
  })
  return teams.map((team) => ({
    callProvider: team.callProvider as TeamRecord['callProvider'],
    createdAt: team.createdAt.toISOString(),
    // UOA holds a bound team's name, so a rename here is relayed to UOA
    // rather than written locally; a surface uses this to say so. The external
    // id itself is never exposed — a surface needs the fact, not the identifier.
    externallyManaged: team.externalTeamId !== null,
    id: parseTeamId(team.id),
    memberCount: team.members.length,
    name: team.name,
    projectId: parseProjectId(team.projectId),
  }))
}

export class ProjectValidationError extends Error {}

const requireName = (value: string | undefined, what: string): string => {
  const name = value?.trim()
  if (!name) {
    throw new ProjectValidationError(`${what} name is required`)
  }
  return name
}

/**
 * Create a project owned by the acting user.
 *
 * The membership is deliberately a single row — the person who asked for it,
 * role `owner`. A project is not announced to the organisation and no other
 * member is added: an org owner can read every project by entitlement, but the
 * *audience* of what lands inside it starts as one person.
 */
export const createProjectForUser = async (
  prisma: PrismaClient,
  input: { name: string; organizationId: string; userId: string },
): Promise<ProjectRecord> => {
  const name = requireName(input.name, 'Project')
  const project = await prisma.project.create({
    data: {
      name,
      organizationId: input.organizationId,
      members: { create: { userId: input.userId, role: 'owner' } },
      boards: { create: defaultBoardCreateData(input.organizationId) },
    },
    include: projectCountsInclude,
  })
  return mapProjectRecord(project)
}

/**
 * Create a team inside a project, owned by the acting user.
 *
 * Returns null when the project is not a real, non-container project of this
 * organisation — the same `404 Project not found` the route emits, and the same
 * refusal for a cross-organisation `projectId`.
 */
export const createTeamForUser = async (
  prisma: PrismaClient,
  input: { name: string; organizationId: string; projectId: string; userId: string },
): Promise<TeamRecord | null> => {
  const name = requireName(input.name, 'Team')
  const project = await prisma.project.findFirst({
    where: {
      channelRoot: false,
      id: input.projectId,
      organizationId: input.organizationId,
    },
    select: { id: true },
  })
  if (!project) return null

  const team = await prisma.team.create({
    data: {
      name,
      projectId: project.id,
      members: { create: { userId: input.userId, role: 'owner' } },
    },
  })
  return {
    callProvider: team.callProvider as TeamRecord['callProvider'],
    createdAt: team.createdAt.toISOString(),
    id: parseTeamId(team.id),
    name: team.name,
    projectId: parseProjectId(team.projectId),
  }
}
