import type { FastifyInstance } from 'fastify'

import {
  ProjectMemberRecordSchema,
  ProjectRecordSchema,
  UpdateProjectBodySchema,
} from '../contracts.js'
import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import { emitAuditEvent } from '../services/audit.js'
import { defaultColumnCreateData } from '../services/board.js'
import { requireLocalMembershipManagement } from './membership-mode-gate.js'
import type { RouteDeps } from './types.js'

const projectCountsInclude = {
  members: { select: { userId: true, role: true } },
  teams: { select: { _count: { select: { channels: true } } } },
} as const

type ProjectWithCounts = {
  id: string
  name: string
  organizationId: string
  createdAt: Date
  members: { userId: string; role: string }[]
  teams: { _count: { channels: number } }[]
}

const toProjectRecord = (project: ProjectWithCounts) => ({
  id: project.id,
  name: project.name,
  organizationId: project.organizationId,
  memberCount: project.members.length,
  teamCount: project.teams.length,
  channelCount: project.teams.reduce((total, team) => total + team._count.channels, 0),
  createdAt: project.createdAt.toISOString(),
})

export const registerProjectRoutes = (app: FastifyInstance, deps: RouteDeps): void => {
  const {
    config,
    prisma,
    requireActorContext,
    requireOwner,
    resolveMembershipRole,
    MEMBERSHIP_ROLES,
    isProjectAccessibleToActor,
    listAccessibleProjectIds,
  } = deps

  app.get('/api/projects', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply

    // Non-owners only see the projects they are a member of.
    const accessible = await listAccessibleProjectIds(actorContext)
    const projects = await prisma.project.findMany({
      where: {
        organizationId: actorContext.tenant.organizationId,
        ...(accessible === 'all' ? {} : { id: { in: accessible } }),
      },
      include: projectCountsInclude,
      orderBy: { createdAt: 'asc' },
    })

    return createApiResponse(
      ProjectRecordSchema.array().parse(projects.map(toProjectRecord)),
    )
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
      where: { id: projectId, organizationId: actorContext.tenant.organizationId },
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
      where: { id: projectId, organizationId: actorContext.tenant.organizationId },
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

    const project = await prisma.project.create({
      data: {
        name: body.name,
        organizationId: actorContext.tenant.organizationId,
        members: {
          create: { userId: actorContext.actor.actorId, role: 'owner' },
        },
        boardColumns: {
          create: defaultColumnCreateData(actorContext.tenant.organizationId),
        },
      },
    })

    await emitAuditEvent(prisma, {
      actorContext,
      action: 'project.created' as Parameters<typeof emitAuditEvent>[1]['action'],
      resourceType: 'project',
      resourceId: project.id,
      outcome: 'success',
    })

    return reply.code(201).send(createApiResponse(ProjectRecordSchema.parse({
      id: project.id,
      name: project.name,
      organizationId: project.organizationId,
      memberCount: 1,
      teamCount: 0,
      channelCount: 0,
      createdAt: project.createdAt.toISOString(),
    })))
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
        id: projectId,
        organizationId: actorContext.tenant.organizationId,
      },
      select: { id: true },
    })
    if (!project) {
      sendApiError(reply, 404, 'PROJECT_NOT_FOUND', 'Project not found')
      return reply
    }

    const updatedProject = await prisma.project.update({
      where: { id: project.id },
      data: { name: body.name },
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
    const project = await prisma.project.findFirst({
      where: { id: projectId, organizationId: actorContext.tenant.organizationId },
      include: projectCountsInclude,
    })
    if (!project) {
      sendApiError(reply, 404, 'PROJECT_NOT_FOUND', 'Project not found')
      return reply
    }

    const channelCount = project.teams.reduce((total, team) => total + team._count.channels, 0)
    if (channelCount > 0) {
      sendApiError(
        reply,
        409,
        'PROJECT_NOT_EMPTY',
        'Move or delete the project\'s channels before deleting it',
      )
      return reply
    }

    await prisma.project.delete({ where: { id: project.id } })

    await emitAuditEvent(prisma, {
      actorContext,
      action: 'project.deleted' as Parameters<typeof emitAuditEvent>[1]['action'],
      resourceType: 'project',
      resourceId: project.id,
      outcome: 'success',
    })

    return createApiResponse({ ok: true })
  })

  app.post('/api/projects/:projectId/members', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireOwner(actorContext, reply)) return reply
    if (!requireLocalMembershipManagement(config.mode, reply)) return reply

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

    const project = await prisma.project.findUnique({ where: { id: projectId } })
    if (!project || project.organizationId !== actorContext.tenant.organizationId) {
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
    if (!requireLocalMembershipManagement(config.mode, reply)) return reply

    const { projectId, userId } = request.params as { projectId: string; userId: string }
    const project = await prisma.project.findFirst({
      where: { id: projectId, organizationId: actorContext.tenant.organizationId },
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
