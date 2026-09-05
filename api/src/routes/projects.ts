import type { FastifyInstance } from 'fastify'
import {
  createProjectForUser,
  deleteProject,
  listProjectsForUser,
  mapProjectRecord,
  projectCountsInclude,
  ProjectValidationError,
} from '@nessie/team-admin'

import {
  ProjectMemberRecordSchema,
  ProjectRecordSchema,
  UpdateProjectBodySchema,
} from '../contracts.js'
import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import { emitAuditEvent } from '../services/audit.js'
import { canAccessAttachment } from '../services/attachments.js'
import { requireUnboundMembershipManagement } from './membership-mode-gate.js'
import type { RouteDeps } from './types.js'

const toProjectRecord = mapProjectRecord

export const registerProjectRoutes = (app: FastifyInstance, deps: RouteDeps): void => {
  const {
    prisma,
    requireActorContext,
    requireOwner,
    resolveMembershipRole,
    MEMBERSHIP_ROLES,
    isProjectAccessibleToActor,
  } = deps

  app.get('/api/projects', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply

    // Non-owners only see the projects they are a member of. The shared reader
    // is the one the `project_list` tool asks too.
    const projects = await listProjectsForUser(prisma, {
      isOwner: actorContext.actor.roles?.includes('owner') === true,
      organizationId: actorContext.tenant.organizationId,
      userId: actorContext.actor.actorId,
    })

    return createApiResponse(ProjectRecordSchema.array().parse(projects))
  })

  app.get('/api/projects/:projectId', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply

    const { projectId } = request.params as { projectId: string }
    if (!(await isProjectAccessibleToActor(actorContext, projectId))) {
      sendApiError(reply, 404, 'PROJECT_NOT_FOUND', 'Project not found')
      return reply
    }
    const project = await prisma.project.findFirst({
      where: {
        channelRoot: false,
        id: projectId,
        organizationId: actorContext.tenant.organizationId,
      },
      include: projectCountsInclude,
    })
    if (!project) {
      sendApiError(reply, 404, 'PROJECT_NOT_FOUND', 'Project not found')
      return reply
    }

    return createApiResponse(ProjectRecordSchema.parse(toProjectRecord(project)))
  })

  app.get('/api/projects/:projectId/members', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply

    const { projectId } = request.params as { projectId: string }
    if (!(await isProjectAccessibleToActor(actorContext, projectId))) {
      sendApiError(reply, 404, 'PROJECT_NOT_FOUND', 'Project not found')
      return reply
    }
    const project = await prisma.project.findFirst({
      where: {
        channelRoot: false,
        id: projectId,
        organizationId: actorContext.tenant.organizationId,
      },
      include: {
        members: {
          include: { user: { select: { id: true, displayName: true, email: true } } },
          orderBy: { createdAt: 'asc' },
        },
      },
    })
    if (!project) {
      sendApiError(reply, 404, 'PROJECT_NOT_FOUND', 'Project not found')
      return reply
    }

    return createApiResponse(ProjectMemberRecordSchema.array().parse(project.members.map((m) => ({
      userId: m.userId,
      displayName: m.user.displayName,
      email: m.user.email,
      role: m.role,
    }))))
  })

  app.post('/api/projects', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireOwner(actorContext, reply)) return reply

    const body = request.body as { name?: string } | undefined
    if (!body?.name) {
      sendApiError(reply, 400, 'NAME_REQUIRED', 'Project name is required')
      return reply
    }

    // The same function the `project_create` tool calls: the owner membership
    // row and the default board columns are written in one place.
    let project
    try {
      project = await createProjectForUser(prisma, {
        name: body.name,
        organizationId: actorContext.tenant.organizationId,
        userId: actorContext.actor.actorId,
      })
    } catch (error) {
      if (error instanceof ProjectValidationError) {
        sendApiError(reply, 400, 'NAME_REQUIRED', error.message)
        return reply
      }
      throw error
    }

    await emitAuditEvent(prisma, {
      actorContext,
      action: 'project.created' as Parameters<typeof emitAuditEvent>[1]['action'],
      resourceType: 'project',
      resourceId: project.id,
      outcome: 'success',
    })

    return reply.code(201).send(
      createApiResponse(ProjectRecordSchema.parse(project)),
    )
  })

  app.patch('/api/projects/:projectId', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireOwner(actorContext, reply)) return reply

    const { projectId } = request.params as { projectId: string }
    const body = parseInput(UpdateProjectBodySchema, request.body, reply)
    if (!body) return reply

    const project = await prisma.project.findFirst({
      where: {
        channelRoot: false,
        id: projectId,
        organizationId: actorContext.tenant.organizationId,
      },
      select: {
        id: true,
        name: true,
        teams: { where: { externalTeamId: { not: null } }, select: { id: true }, take: 1 },
      },
    })
    if (!project) {
      sendApiError(reply, 404, 'PROJECT_NOT_FOUND', 'Project not found')
      return reply
    }

    // A project backing a UOA team takes its name from that team:
    // `syncExternalTeamNames` rewrites it from the verified directory on
    // every login and rotation. Accepting a local rename made the value persist
    // just long enough to look saved before a refresh silently reverted it.
    // The avatar below is Nessie's own and stays editable.
    if (body.name !== undefined && project.teams.length > 0 && body.name !== project.name) {
      sendApiError(
        reply,
        409,
        'TEAM_NAME_MANAGED_BY_SSO',
        'This team is named in UnlikeOtherAI. Rename it there and the change will appear here.',
      )
      return reply
    }

    if (body.avatarAttachmentId) {
      const attachment = await prisma.attachment.findUnique({
        where: { id: body.avatarAttachmentId },
      })
      if (
        !attachment
        || !(await canAccessAttachment(prisma, attachment, {
          organizationId: actorContext.tenant.organizationId,
          userId: actorContext.actor.actorId,
        }))
      ) {
        sendApiError(reply, 404, 'ATTACHMENT_NOT_FOUND', 'Attachment not found')
        return reply
      }
      if (attachment.kind !== 'image') {
        sendApiError(reply, 400, 'INVALID_PROJECT_AVATAR', 'Project photo must be an image')
        return reply
      }
    }

    const avatarIdentity = body.avatarAttachmentId
      ? { avatarAttachmentId: body.avatarAttachmentId, avatarEmoji: null }
      : body.avatarEmoji
        ? { avatarAttachmentId: null, avatarEmoji: body.avatarEmoji }
        : {
            ...(body.avatarAttachmentId === null ? { avatarAttachmentId: null } : {}),
            ...(body.avatarEmoji === null ? { avatarEmoji: null } : {}),
          }

    const updatedProject = await prisma.project.update({
      where: { id: project.id },
      data: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...avatarIdentity,
      },
      include: projectCountsInclude,
    })

    await emitAuditEvent(prisma, {
      actorContext,
      action: 'project.updated' as Parameters<typeof emitAuditEvent>[1]['action'],
      resourceType: 'project',
      resourceId: updatedProject.id,
      outcome: 'success',
    })

    return createApiResponse(ProjectRecordSchema.parse(toProjectRecord(updatedProject)))
  })

  app.delete('/api/projects/:projectId', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireOwner(actorContext, reply)) return reply

    const { projectId } = request.params as { projectId: string }
    // What deleting a project destroys is owned by `deleteProject`, not by this
    // handler: it enumerates every blocking family in one place and returns one
    // typed refusal per family. The route parses, calls, and maps.
    const result = await deleteProject(prisma, {
      organizationId: actorContext.tenant.organizationId,
      projectId,
    })

    if (result.kind === 'not_found') {
      sendApiError(reply, 404, 'PROJECT_NOT_FOUND', 'Project not found')
      return reply
    }
    if (result.kind === 'blocked') {
      // The first family is the code and the message; every family travels in
      // `details` so a person emptying the project is not sent round the loop
      // once per family.
      const primary = result.blocks[0]!
      sendApiError(reply, 409, primary.code, primary.message, undefined, {
        blocks: result.blocks.map((block) => ({
          code: block.code,
          count: block.count,
          message: block.message,
        })),
      })
      return reply
    }
    if (result.kind === 'referenced') {
      sendApiError(
        reply,
        409,
        'PROJECT_NOT_EMPTY',
        'Something in this project still references it. Empty the project and try again.',
      )
      return reply
    }

    await emitAuditEvent(prisma, {
      actorContext,
      action: 'project.deleted' as Parameters<typeof emitAuditEvent>[1]['action'],
      resourceType: 'project',
      resourceId: projectId,
      outcome: 'success',
    })

    return createApiResponse({ ok: true })
  })

  app.post('/api/projects/:projectId/members', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireOwner(actorContext, reply)) return reply
    if (
      !(await requireUnboundMembershipManagement(prisma, reply, {
        organizationId: actorContext.tenant.organizationId,
      }))
    ) {
      return reply
    }

    const { projectId } = request.params as { projectId: string }
    const body = request.body as { userId?: string; role?: string } | undefined
    if (!body?.userId) {
      sendApiError(reply, 400, 'USER_ID_REQUIRED', 'userId is required')
      return reply
    }

    const role = resolveMembershipRole(body.role)
    if (!role) {
      sendApiError(reply, 400, 'INVALID_ROLE', `role must be one of: ${MEMBERSHIP_ROLES.join(', ')}`)
      return reply
    }

    const project = await prisma.project.findFirst({
      where: {
        channelRoot: false,
        id: projectId,
        organizationId: actorContext.tenant.organizationId,
      },
    })
    if (!project) {
      sendApiError(reply, 404, 'NOT_FOUND', 'Project not found')
      return reply
    }

    // `userId` is raw request body. Confirm it belongs to this organisation so a
    // foreign-tenant id cannot be written into the membership table.
    const targetIsOrgMember = await prisma.organizationMember.count({
      where: {
        organizationId: actorContext.tenant.organizationId,
        userId: body.userId,
      },
    })
    if (targetIsOrgMember === 0) {
      sendApiError(reply, 404, 'USER_NOT_FOUND', 'User is not a member of this organization')
      return reply
    }

    await prisma.projectMember.create({
      data: {
        projectId,
        userId: body.userId,
        role,
      },
    })

    return reply.code(201).send(createApiResponse({ ok: true }))
  })

  app.delete('/api/projects/:projectId/members/:userId', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireOwner(actorContext, reply)) return reply
    if (
      !(await requireUnboundMembershipManagement(prisma, reply, {
        organizationId: actorContext.tenant.organizationId,
      }))
    ) {
      return reply
    }

    const { projectId, userId } = request.params as { projectId: string; userId: string }
    const project = await prisma.project.findFirst({
      where: {
        channelRoot: false,
        id: projectId,
        organizationId: actorContext.tenant.organizationId,
      },
      select: { id: true },
    })
    if (!project) {
      sendApiError(reply, 404, 'NOT_FOUND', 'Project not found')
      return reply
    }

    const result = await prisma.projectMember.deleteMany({ where: { projectId, userId } })
    if (result.count === 0) {
      sendApiError(reply, 404, 'MEMBER_NOT_FOUND', 'Project member not found')
      return reply
    }

    return createApiResponse({ ok: true })
  })
}
