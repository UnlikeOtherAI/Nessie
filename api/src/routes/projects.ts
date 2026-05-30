import type { FastifyInstance } from 'fastify'

import { ProjectRecordSchema, UpdateProjectBodySchema } from '../contracts.js'
import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import { emitAuditEvent } from '../services/audit.js'
import type { RouteDeps } from './types.js'

export const registerProjectRoutes = (app: FastifyInstance, deps: RouteDeps): void => {
  const { prisma, requireActorContext, requireOwner, resolveMembershipRole, MEMBERSHIP_ROLES } = deps

  app.get('/api/projects', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply

    const projects = await prisma.project.findMany({
      where: { organizationId: actorContext.tenant.organizationId },
      include: { members: { select: { userId: true, role: true } } },
      orderBy: { createdAt: 'asc' },
    })

    return createApiResponse(ProjectRecordSchema.array().parse(projects.map((p) => ({
      id: p.id,
      name: p.name,
      organizationId: p.organizationId,
      memberCount: p.members.length,
      createdAt: p.createdAt.toISOString(),
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
      include: { members: { select: { userId: true, role: true } } },
    })
    if (!project) {
      sendApiError(reply, 404, 'PROJECT_NOT_FOUND', 'Project not found')
      return reply
    }

    const updatedProject = await prisma.project.update({
      where: { id: project.id },
      data: { name: body.name },
      include: { members: { select: { userId: true, role: true } } },
    })

    await emitAuditEvent(prisma, {
      actorContext,
      action: 'project.updated' as Parameters<typeof emitAuditEvent>[1]['action'],
      resourceType: 'project',
      resourceId: updatedProject.id,
      outcome: 'success',
    })

    return createApiResponse(ProjectRecordSchema.parse({
      id: updatedProject.id,
      name: updatedProject.name,
      organizationId: updatedProject.organizationId,
      memberCount: updatedProject.members.length,
      createdAt: updatedProject.createdAt.toISOString(),
    }))
  })

  app.post('/api/projects/:projectId/members', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireOwner(actorContext, reply)) return reply

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

    await prisma.projectMember.create({
      data: {
        projectId,
        userId: body.userId,
        role,
      },
    })

    return reply.code(201).send(createApiResponse({ ok: true }))
  })
}
