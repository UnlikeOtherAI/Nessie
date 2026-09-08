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
  channels: { select: { id: true } },
  teams: { select: { id: true } },
  team: { select: { id: true } },
} as const

type ProjectWithCounts = {
  id: string
  name: string
  avatarEmoji: string | null
  avatarAttachmentId: string | null
  organizationId: string
  createdAt: Date
  members: { userId: string; role: string }[]
  channels: { id: string }[]
  teams: { id: string }[]
  team: { id: string } | null
}

export const mapProjectRecord = (project: ProjectWithCounts): ProjectRecord => ({
  id: parseProjectId(project.id),
  name: project.name,
  avatarEmoji: project.avatarEmoji,
  avatarAttachmentId: project.avatarAttachmentId,
  organizationId: parseOrganizationId(project.organizationId),
  memberCount: project.members.length,
  teamCount: project.team ? 1 : project.teams.length,
  channelCount: project.channels.length,
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
      systemManaged: false,
      OR: [
        { project: { organizationId: input.organizationId } },
        { projects: { some: { organizationId: input.organizationId } } },
      ],
    },
    include: { members: { select: { userId: true } }, projects: { select: { id: true } } },
    orderBy: { createdAt: 'asc' },
  })
  return teams.flatMap((team) => {
    const projectIds = [...new Set([team.projectId, ...team.projects.map((project) => project.id)])]
    return projectIds.filter((projectId) => !input.projectIds || input.projectIds.includes(projectId)).map((projectId) => ({
    callProvider: team.callProvider as TeamRecord['callProvider'],
    createdAt: team.createdAt.toISOString(),
    // UOA holds a bound team's name, so a rename here is relayed to UOA
    // rather than written locally; a surface uses this to say so. The external
    // id itself is never exposed — a surface needs the fact, not the identifier.
    externallyManaged: team.externalTeamId !== null,
    id: parseTeamId(team.id),
    memberCount: team.members.length,
    name: team.name,
    projectId: parseProjectId(projectId),
    }))
  })
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
  input: { name: string; organizationId: string; teamId: string; userId: string },
): Promise<ProjectRecord> => {
  const name = requireName(input.name, 'Project')
  // The legacy Team.projectId still exists for rows that have not passed the
  // audited inversion backfill. It establishes the team's tenant here; this
  // write itself uses the canonical Project.teamId relation.
  const team = await prisma.team.findFirst({
    where: { id: input.teamId, project: { organizationId: input.organizationId } },
    select: { id: true },
  })
  if (!team) throw new ProjectValidationError('Team not found in this organization')
  const [teamMember, organizationMember] = await Promise.all([
    prisma.teamMember.findUnique({
      where: { teamId_userId: { teamId: team.id, userId: input.userId } },
      select: { id: true },
    }),
    prisma.organizationMember.findUnique({
      where: { organizationId_userId: { organizationId: input.organizationId, userId: input.userId } },
      select: { deactivatedAt: true, role: true },
    }),
  ])
  if (
    !organizationMember
    || organizationMember.deactivatedAt
    || (!teamMember && organizationMember.role !== 'owner' && organizationMember.role !== 'admin')
  ) {
    throw new ProjectValidationError('You are not allowed to create a project in that team')
  }
  const project = await prisma.project.create({
    data: {
      name,
      organizationId: input.organizationId,
      teamId: team.id,
      members: { create: { userId: input.userId, role: 'owner' } },
      boards: { create: defaultBoardCreateData(input.organizationId) },
    },
    include: projectCountsInclude,
  })
  return mapProjectRecord(project)
}

/**
 * A team may not be born locally inside an organisation UOA binds.
 *
 * `docs/standards/team-model.md`: "A team IS a UOA team. Not a copy of one, not
 * a container for one." A locally created `Team` there is a level of the org
 * hierarchy UOA has never heard of, carrying local `TeamMember` rows nothing
 * upstream authorized (2026-09-05 API review, FO2-3). `relayRoute` names the
 * door that does tell UOA, so the refusal can say where to go instead.
 */
export class UoaBoundOrganizationError extends Error {
  constructor(readonly relayRoute: string) {
    super(
      'This organisation is managed by UnlikeOtherAI, which owns its teams. '
      + `Create the team through ${relayRoute} so UnlikeOtherAI is told about it.`,
    )
    this.name = 'UoaBoundOrganizationError'
  }
}

/**
 * Create a team inside a project, owned by the acting user.
 *
 * Returns null when the project is not a real, non-container project of this
 * organisation — the same `404 Project not found` the route emits, and the same
 * refusal for a cross-organisation `projectId`. Throws
 * `UoaBoundOrganizationError` when the organisation is UOA-bound: the local
 * `Team` row is the same thing as a UOA team, so it has to be created upstream.
 */
export const createTeamForUser = async (
  prisma: PrismaClient,
  input: { name: string; organizationId: string; projectId: string; userId: string },
): Promise<TeamRecord | null> => {
  const name = requireName(input.name, 'Team')
  const organization = await prisma.organization.findUnique({
    where: { id: input.organizationId },
    select: { externalOrgId: true },
  })
  if (organization?.externalOrgId) {
    throw new UoaBoundOrganizationError('POST /api/teams/teams')
  }
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
