import type { FastifyInstance } from 'fastify'
import {
  createProjectForUser,
  deleteProject,
  mapProjectRecord,
  projectCountsInclude,
  ProjectValidationError,
} from '@nessie/team-admin'

import {
  CreateProjectBodySchema,
  ProjectMemberRecordSchema,
  ProjectRecordSchema,
  UpdateProjectBodySchema,
} from '../contracts/team.js'
import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import { emitAuditEvent } from '../services/audit.js'
import { canAccessAttachment } from '../services/attachments.js'
import { registerProjectReadRoutes } from './project-reads.js'
import type { RouteDeps } from './types.js'

const toProjectRecord = mapProjectRecord

/**
 * Project membership is Nessie's own: UOA owns organisation and team
 * membership, and has never heard of a project. So a UOA-bound organisation
 * manages a real project's members here, exactly as an unbound one does, and
 * `requireUnboundMembershipManagement` does not gate these routes.
 *
 * One kind of project is not Nessie's: the anchor project `createTeamEnvironment`
 * fabricates for a UOA-bound team (`Team.projectId`). Sign-in writes its
 * `ProjectMember` rows from the verified team membership
 * (`ensureTeamMemberships`), re-projects their role (`projectUoaRoles`) and
 * removes them when UOA withdraws the team (`reconcileUoaMembershipProjection`).
 * A local write there would fight that projection — a removal undone at the next
 * login, an addition surviving as a second authority UOA never granted — so it
 * is refused, and the team's membership is the place to change it.
 */
const projectMembershipSelect = {
  id: true,
  teams: { where: { externalTeamId: { not: null } }, select: { id: true }, take: 1 },
} as const

const isTeamProjectedProject = (project: { teams: { id: string }[] }): boolean =>
  project.teams.length > 0

const sendTeamProjectedRefusal = (reply: Parameters<typeof sendApiError>[0]): void => {
  sendApiError(
    reply,
    409,
    'TEAM_PROJECT_MEMBERSHIP_MANAGED_BY_SSO',
    'This project mirrors a team in UnlikeOtherAI, so its members are that team\'s members. Change the team\'s membership there instead.',
  )
}

export const registerProjectRoutes = (app: FastifyInstance, deps: RouteDeps): void => {
  const {
    prisma,
    requireActorContext,
    requireProjectModifier,
    resolveMembershipRole,
    MEMBERSHIP_ROLES,
    isProjectAccessibleToActor,
  } = deps

  registerProjectReadRoutes(app, deps)


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
        deletedAt: null,
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

  // Any member of the organisation may create a project. What has to be earned
  // is the placement — the team named in the body — and `createProjectForUser`
  // decides that: a member of that team, or an organisation owner or admin.
  app.post('/api/projects', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply

    const body = CreateProjectBodySchema.safeParse(request.body)
    if (!body.success) {
      sendApiError(reply, 400, 'PROJECT_TEAM_REQUIRED', 'A project name and an existing team are required')
      return reply
    }

    // The same function the `project_create` tool calls: the creator's
    // membership row and the default board columns are written in one place.
    let project
    try {
      project = await createProjectForUser(prisma, {
        name: body.data.name,
        organizationId: actorContext.tenant.organizationId,
        teamId: body.data.teamId,
        userId: actorContext.actor.actorId,
        // Defaulting is `createProjectForUser`'s, not the route's, so the
        // Agent Designer's `project_create` tool lands on the same `public`.
        ...(body.data.visibility === undefined ? {} : { visibility: body.data.visibility }),
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
      action: 'project.created',
      resourceType: 'project',
      resourceId: project.id,
      outcome: 'success',
    })

    return reply.code(201).send(
      createApiResponse(ProjectRecordSchema.parse(project)),
    )
  })

  // Every write below takes `requireProjectModifier`: any member of the
  // project, or an organisation owner or admin. Everybody else cannot see the
  // project and gets the same 404 the read gives them.
  app.patch('/api/projects/:projectId', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply

    const { projectId } = request.params as { projectId: string }
    if (!(await requireProjectModifier(actorContext, projectId, reply))) return reply
    const body = parseInput(UpdateProjectBodySchema, request.body, reply)
    if (!body) return reply

    const project = await prisma.project.findFirst({
      where: {
        channelRoot: false,
        deletedAt: null,
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
        ...(body.description !== undefined ? { description: body.description || null } : {}),
        ...(body.visibility !== undefined ? { visibility: body.visibility } : {}),
        ...avatarIdentity,
      },
      include: projectCountsInclude,
    })

    await emitAuditEvent(prisma, {
      actorContext,
      action: 'project.updated',
      resourceType: 'project',
      resourceId: updatedProject.id,
      outcome: 'success',
    })

    return createApiResponse(ProjectRecordSchema.parse(toProjectRecord(updatedProject)))
  })

  app.delete('/api/projects/:projectId', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply

    const { projectId } = request.params as { projectId: string }
    if (!(await requireProjectModifier(actorContext, projectId, reply))) return reply
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
      action: 'project.deleted',
      resourceType: 'project',
      resourceId: projectId,
      outcome: 'success',
    })

    return createApiResponse({ ok: true })
  })

  app.post('/api/projects/:projectId/members', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    const { projectId } = request.params as { projectId: string }
    if (!(await requireProjectModifier(actorContext, projectId, reply))) return reply

    // `role` is still accepted and stored, but it grants nothing: every member
    // of a project has the same rights in it (`canModifyProject`).
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
        deletedAt: null,
        id: projectId,
        organizationId: actorContext.tenant.organizationId,
      },
      select: projectMembershipSelect,
    })
    if (!project) {
      sendApiError(reply, 404, 'NOT_FOUND', 'Project not found')
      return reply
    }
    if (isTeamProjectedProject(project)) {
      sendTeamProjectedRefusal(reply)
      return reply
    }

    // `userId` is raw request body. Confirm it is an active member of this
    // organisation so a foreign-tenant or deactivated id cannot be written into
    // the membership table.
    const targetIsOrgMember = await prisma.organizationMember.count({
      where: {
        deactivatedAt: null,
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
    const { projectId, userId } = request.params as { projectId: string; userId: string }
    if (!(await requireProjectModifier(actorContext, projectId, reply))) return reply

    const project = await prisma.project.findFirst({
      where: {
        channelRoot: false,
        deletedAt: null,
        id: projectId,
        organizationId: actorContext.tenant.organizationId,
      },
      select: projectMembershipSelect,
    })
    if (!project) {
      sendApiError(reply, 404, 'NOT_FOUND', 'Project not found')
      return reply
    }
    if (isTeamProjectedProject(project)) {
      sendTeamProjectedRefusal(reply)
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
