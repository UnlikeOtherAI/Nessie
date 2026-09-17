import type { PrismaClient } from '@prisma/client'
import {
  parseOrganizationId,
  parseProjectId,
  parseTeamId,
  parseUserId,
  type ProjectDirectoryEntry,
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
 * Any active organisation member may create a project, in a team they are a
 * member of — `createProjectForUser` checks that placement itself (an
 * organisation owner or admin may place one in any team). Creating a team is
 * still an organisation-owner operation: `POST /api/teams` gates with
 * `requireOwner` and `team_create` with `requireOwnerMember`, deliberately
 * outside `createTeamForUser` because bootstrap and team provisioning create
 * rows with no acting owner at all, so a new caller must state its own
 * authorization rather than inherit one silently.
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
  description?: string | null
  visibility: string
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
  description: project.description ?? null,
  organizationId: parseOrganizationId(project.organizationId),
  visibility: project.visibility as ProjectRecord['visibility'],
  memberCount: project.members.length,
  teamCount: project.team ? 1 : project.teams.length,
  channelCount: project.channels.length,
  createdAt: project.createdAt.toISOString(),
})

/**
 * Who is asking about a project. `isOrganizationAdmin` is an organisation owner
 * **or** admin (`isAdminRole` / `isAdminActor`), resolved by the caller from the
 * live membership row — the pair `docs/standards/team-model.md` names as the
 * only people who reach a project they are not a member of.
 */
export type ProjectViewer = {
  isOrganizationAdmin: boolean
  organizationId: string
  userId: string
}

/**
 * Project entitlement: an organisation owner or admin reaches every project in
 * their organisation; everybody else only the projects they are an explicit
 * `ProjectMember` of, whatever that row's role. `'all'` means "no project
 * filter at all".
 *
 * This is the predicate behind `GET /api/projects`, the task list, the board
 * and the iterations routes, and — because every member of a project has equal
 * rights in it — `canModifyProject` too. It is here so the `project_list` tool
 * asks the same question rather than a second one that could answer
 * differently.
 */
export const listAccessibleProjectIds = async (
  prisma: PrismaClient,
  viewer: ProjectViewer,
): Promise<string[] | 'all'> => {
  if (viewer.isOrganizationAdmin) return 'all'
  const memberships = await prisma.projectMember.findMany({
    where: {
      userId: viewer.userId,
      project: { organizationId: viewer.organizationId, deletedAt: null },
    },
    select: { projectId: true },
  })
  return memberships.map((membership) => membership.projectId)
}

export const isProjectAccessibleToUser = async (
  prisma: PrismaClient,
  viewer: ProjectViewer,
  projectId: string,
): Promise<boolean> => {
  // A soft-deleted project is gone for everybody, organisation admins included:
  // every route that gates on this refuses it with the read's own 404.
  const project = await prisma.project.count({
    where: { id: projectId, organizationId: viewer.organizationId, deletedAt: null },
  })
  if (project === 0) return false
  if (viewer.isOrganizationAdmin) return true
  return (
    (await prisma.projectMember.count({
      where: { projectId, userId: viewer.userId },
    })) > 0
  )
}

/**
 * Resolve how a viewer may read ONE project — the question a direct URL asks,
 * which is different from what the browse listing shows.
 *
 * - `'full'` — a project member, an organisation owner/admin, or ANY
 *   organisation member looking at a `public` project. Public means browsable
 *   without joining, so there is nothing to withhold.
 * - `'limited'` — an organisation member opening a `protected` project they are
 *   not in. Name, description and members: enough to know it exists and whom to
 *   ask. This is the arm that makes a protected project reachable at all, since
 *   it is deliberately absent from the directory for this person.
 * - `'none'` — no such project, soft-deleted, or another organisation's.
 *
 * Note which way round the two middle arms go, because an earlier revision of
 * the spec had them swapped in prose (while its own route table and test plan
 * had them this way). Returning `'limited'` for public and `'none'` for
 * protected would be exactly backwards: it would withhold a room anyone may
 * browse, and make a protected room unreachable by direct URL — which is the
 * only way in, and the "discoverable, not invisible" half of decision 4.
 *
 * `canModifyProject` is deliberately NOT this predicate. Reading a public
 * project is now wider than changing it, and collapsing the two would hand
 * every organisation member write access to every board, field, source,
 * iteration and watcher.
 */
export const resolveProjectAccess = async (
  prisma: PrismaClient,
  viewer: ProjectViewer,
  projectId: string,
): Promise<'none' | 'limited' | 'full'> => {
  const project = await prisma.project.findUnique({
    where: { id: projectId, deletedAt: null },
    select: {
      organizationId: true,
      visibility: true,
      members: { where: { userId: viewer.userId }, select: { id: true }, take: 1 },
    },
  })
  if (!project || project.organizationId !== viewer.organizationId) return 'none'
  if (project.members.length > 0 || viewer.isOrganizationAdmin) return 'full'
  if (project.visibility === 'public') return 'full'
  return 'limited'
}

/** The list `GET /api/projects` returns, scoped by the entitlement above. */
export const listProjectsForUser = async (
  prisma: PrismaClient,
  viewer: ProjectViewer,
): Promise<ProjectRecord[]> => {
  const accessible = await listAccessibleProjectIds(prisma, viewer)
  const projects = await prisma.project.findMany({
    where: {
      channelRoot: false,
      deletedAt: null,
      organizationId: viewer.organizationId,
      ...(accessible === 'all'
        ? {}
        : {
            OR: [
              { id: { in: accessible } },
              { visibility: 'public' },
            ],
          }),
    },
    include: projectCountsInclude,
    orderBy: { createdAt: 'asc' },
  })
  return projects.map(mapProjectRecord)
}

/**
 * Every live project in the organisation, shaped by who is asking
 * (`ProjectDirectoryEntrySchema`). Any active organisation member may read it:
 * a person outside a project learns its name, description and members and
 * nothing else, so they know who to ask; a member of it, or an organisation
 * owner or admin, gets the full record too.
 *
 * The limited row is built field by field rather than by deleting keys from the
 * full one, so a field added to the project read can never reach an outsider by
 * default. Only active organisation members are listed as members.
 */
export const listProjectDirectory = async (
  prisma: PrismaClient,
  viewer: ProjectViewer,
): Promise<ProjectDirectoryEntry[]> => {
  const [projects, activeMembers] = await Promise.all([
    prisma.project.findMany({
      where: {
        channelRoot: false,
        deletedAt: null,
        organizationId: viewer.organizationId,
        // Non-members only see public projects in the directory; protected
        // projects are hidden from them. Members and admins see everything.
        ...(viewer.isOrganizationAdmin
          ? {}
          : {
              OR: [
                { visibility: 'public' },
                { members: { some: { userId: viewer.userId } } },
              ],
            }),
      },
      include: {
        ...projectCountsInclude,
        members: {
          select: {
            role: true,
            userId: true,
            user: { select: { avatarAttachmentId: true, avatarUrl: true, displayName: true } },
          },
          orderBy: { createdAt: 'asc' },
        },
      },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.organizationMember.findMany({
      where: { organizationId: viewer.organizationId, deactivatedAt: null },
      select: { userId: true },
    }),
  ])
  const active = new Set(activeMembers.map((member) => member.userId))
  return projects.map((project): ProjectDirectoryEntry => {
    const members = project.members
      .filter((member) => active.has(member.userId))
      .map((member) => ({
        avatarAttachmentId: member.user.avatarAttachmentId,
        avatarUrl: member.user.avatarUrl,
        displayName: member.user.displayName,
        userId: parseUserId(member.userId),
      }))
    const viewerIsMember = project.members.some((member) => member.userId === viewer.userId)
    const base = {
      description: project.description,
      id: parseProjectId(project.id),
      members,
      name: project.name,
      visibility: project.visibility as ProjectDirectoryEntry['visibility'],
    }
    if (!viewerIsMember && !viewer.isOrganizationAdmin) {
      return { access: 'limited', ...base }
    }
    return { access: 'full', ...base, project: mapProjectRecord(project), viewerIsMember }
  })
}

/**
 * The teams `GET /api/teams` returns: every non-system team in the caller's
 * organisation, optionally narrowed to one project. Team reads are org-wide
 * (the route carries only `requireActorContext`), so a caller narrowing this to
 * projects they can read — as `project_list` does — is strictly narrower.
 */
export const listTeamsForOrganization = async (
  prisma: PrismaClient,
  input: { organizationId: string; projectIds?: string[]; viewerUserId?: string },
): Promise<(TeamRecord & { memberCount: number })[]> => {
  const teams = await prisma.team.findMany({
    where: {
      systemManaged: false,
      OR: [
        { project: { organizationId: input.organizationId } },
        { projects: { some: { organizationId: input.organizationId } } },
      ],
    },
    include: {
      members: { select: { userId: true } },
      projects: { where: { deletedAt: null }, select: { id: true } },
    },
    orderBy: { createdAt: 'asc' },
  })
  return teams.flatMap((team) => {
    const projectIds = [...new Set([team.projectId, ...team.projects.map((project) => project.id)])]
    if (input.projectIds && !projectIds.some((projectId) => input.projectIds!.includes(projectId))) return []
    return [{
    callProvider: team.callProvider as TeamRecord['callProvider'],
    createdAt: team.createdAt.toISOString(),
    // UOA holds a bound team's name, so a rename here is relayed to UOA
    // rather than written locally; a surface uses this to say so. The external
    // id itself is never exposed — a surface needs the fact, not the identifier.
    externallyManaged: team.externalTeamId !== null,
    id: parseTeamId(team.id),
    memberCount: team.members.length,
    ...(input.viewerUserId
      ? { viewerIsMember: team.members.some((member) => member.userId === input.viewerUserId) }
      : {}),
    name: team.name,
    projectId: parseProjectId(team.projectId),
    projectIds: projectIds.map(parseProjectId),
    }]
  })
}

export class ProjectValidationError extends Error {}

/** The one channel every new project starts with. */
export const PROJECT_DEFAULT_CHANNEL_NAME = 'general'

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
  input: {
    name: string
    organizationId: string
    teamId: string
    userId: string
    visibility?: 'public' | 'protected'
  },
): Promise<ProjectRecord> => {
  const name = requireName(input.name, 'Project')
  const visibility = input.visibility ?? 'public'
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
      visibility,
      members: { create: { userId: input.userId, role: 'owner' } },
      boards: { create: defaultBoardCreateData(input.organizationId) },
      // A project starts with its own #general and nothing else. Memberless and
      // public like every seeded channel, and in the project's own team — never
      // the organisation's shared channel root.
      channels: {
        create: {
          label: PROJECT_DEFAULT_CHANNEL_NAME,
          slug: PROJECT_DEFAULT_CHANNEL_NAME,
          organizationId: input.organizationId,
          teamId: team.id,
          visibility: 'public',
        },
      },
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
