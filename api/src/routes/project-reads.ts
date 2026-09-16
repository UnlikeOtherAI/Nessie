import type { FastifyInstance } from 'fastify'
import {
  listProjectDirectory,
  listProjectsForUser,
  mapProjectRecord,
  projectCountsInclude,
  resolveProjectAccess,
} from '@nessie/team-admin'
import {
  isAdminActor,
  parseProjectId,
  parseUserId,
  ProjectDirectoryEntrySchema,
} from '@nessie/schemas'

import { ProjectRecordSchema } from '../contracts/team.js'
import { createApiResponse, sendApiError } from '../lib/api.js'
import type { RouteDeps } from './types.js'

const toProjectRecord = mapProjectRecord

/**
 * Reading projects, shaped by what the caller is entitled to see.
 *
 * Split from `routes/projects.ts` — which owns the writes — because the two
 * answer different questions and the file had grown past the size cap. Reading
 * is now genuinely separate from modifying: since projects gained a
 * `visibility`, an organisation member may READ a public project they are not
 * in, while changing it still takes `canModifyProject` (membership, or an
 * organisation owner/admin). Widening the read must never widen the write, and
 * keeping them in separate modules with separate predicates is what stops the
 * next change from collapsing them back together.
 */
export const registerProjectReadRoutes = (app: FastifyInstance, deps: RouteDeps): void => {
  const { prisma, requireActorContext } = deps

  app.get('/api/projects', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply

    // Anybody but an organisation owner or admin only sees the projects they
    // are a member of. The shared reader is the one the `project_list` tool
    // asks too.
    const projects = await listProjectsForUser(prisma, {
      isOrganizationAdmin: isAdminActor(actorContext),
      organizationId: actorContext.tenant.organizationId,
      userId: actorContext.actor.actorId,
    })

    return createApiResponse(ProjectRecordSchema.array().parse(projects))
  })

  // Every live project in the organisation, shaped by role: outsiders see a
  // project's name, description and members only, so they know it exists and
  // whom to ask; members and organisation owners/admins get the full record.
  // Registered before `/:projectId` so the literal segment is not read as an id.
  app.get('/api/projects/directory', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply

    const entries = await listProjectDirectory(prisma, {
      isOrganizationAdmin: isAdminActor(actorContext),
      organizationId: actorContext.tenant.organizationId,
      userId: actorContext.actor.actorId,
    })
    return createApiResponse(ProjectDirectoryEntrySchema.array().parse(entries))
  })

  /**
   * One project, shaped by what this caller may see of it — the doorway a
   * protected project is opened through, since it is absent from the directory
   * for a non-member.
   *
   * Returns a `ProjectDirectoryEntry`, not a bare `ProjectRecord`, because the
   * answer is a discriminated union: `limited` (name, description, members) for
   * an organisation member outside a public project, `full` for a member or an
   * organisation owner/admin. A non-member of a PROTECTED project is refused
   * with the same `404` a non-existent project gives, so the refusal never
   * confirms the room exists to somebody who may not know.
   */
  app.get('/api/projects/:projectId', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply

    const { projectId } = request.params as { projectId: string }
    const viewer = {
      isOrganizationAdmin: isAdminActor(actorContext),
      organizationId: actorContext.tenant.organizationId,
      userId: actorContext.actor.actorId,
    }
    const access = await resolveProjectAccess(prisma, viewer, projectId)
    if (access === 'none') {
      sendApiError(reply, 404, 'PROJECT_NOT_FOUND', 'Project not found')
      return reply
    }

    const project = await prisma.project.findFirst({
      where: {
        channelRoot: false,
        deletedAt: null,
        id: projectId,
        organizationId: actorContext.tenant.organizationId,
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
    })
    if (!project) {
      sendApiError(reply, 404, 'PROJECT_NOT_FOUND', 'Project not found')
      return reply
    }

    // Deactivated people are dropped: a `ProjectMember` row outlives the
    // person's access, and a name on a list is a disclosure of its own.
    const active = new Set(
      (await prisma.organizationMember.findMany({
        where: { organizationId: actorContext.tenant.organizationId, deactivatedAt: null },
        select: { userId: true },
      })).map((member) => member.userId),
    )
    const members = project.members
      .filter((member) => active.has(member.userId))
      .map((member) => ({
        avatarAttachmentId: member.user.avatarAttachmentId,
        avatarUrl: member.user.avatarUrl,
        displayName: member.user.displayName,
        userId: parseUserId(member.userId),
      }))
    const base = {
      description: project.description,
      id: parseProjectId(project.id),
      members,
      name: project.name,
      visibility: project.visibility as 'public' | 'protected',
    }

    if (access === 'limited') {
      return createApiResponse(ProjectDirectoryEntrySchema.parse({ access: 'limited', ...base }))
    }
    return createApiResponse(ProjectDirectoryEntrySchema.parse({
      access: 'full',
      ...base,
      project: toProjectRecord(project),
      viewerIsMember: project.members.some((member) => member.userId === viewer.userId),
    }))
  })
}
