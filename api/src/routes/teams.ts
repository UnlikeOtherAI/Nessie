import type { FastifyInstance } from 'fastify'
import {
  CallLinkProviderSchema,
  isCallLinkProviderConfigured,
} from '@nessie/workspace-admin'
import { z } from 'zod'

import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import { emitAuditEvent } from '../services/audit.js'
import { requireLocalMembershipManagement } from './membership-mode-gate.js'
import type { RouteDeps } from './types.js'

const UpdateTeamSettingsBodySchema = z.object({
  callProvider: CallLinkProviderSchema,
}).strict()

export const registerTeamRoutes = (app: FastifyInstance, deps: RouteDeps): void => {
  const {
    config,
    prisma,
    requireActorContext,
    requireOwner,
    resolveMembershipRole,
    MEMBERSHIP_ROLES,
  } = deps

  app.get('/api/teams', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply

    const query = request.query as { projectId?: string }
    const where: Record<string, unknown> = {
      project: { organizationId: actorContext.tenant.organizationId },
      systemManaged: false,
    }
    if (query.projectId) {
      where['projectId'] = query.projectId
    }

    const teams = await prisma.team.findMany({
      where,
      include: { members: { select: { userId: true, role: true } } },
      orderBy: { createdAt: 'asc' },
    })

    return createApiResponse(teams.map((t) => ({
      id: t.id,
      name: t.name,
      projectId: t.projectId,
      memberCount: t.members.length,
      createdAt: t.createdAt.toISOString(),
    })))
  })

  app.post('/api/teams', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireOwner(actorContext, reply)) return reply

    const body = request.body as { name?: string; projectId?: string } | undefined
    if (!body?.name || !body?.projectId) {
      sendApiError(reply, 400, 'INVALID_INPUT', 'name and projectId are required')
      return reply
    }

    const project = await prisma.project.findFirst({
      where: {
        channelRoot: false,
        id: body.projectId,
        organizationId: actorContext.tenant.organizationId,
      },
    })
    if (!project) {
      sendApiError(reply, 404, 'NOT_FOUND', 'Project not found')
      return reply
    }

    const team = await prisma.team.create({
      data: {
        name: body.name,
        projectId: body.projectId,
        members: {
          create: { userId: actorContext.actor.actorId, role: 'owner' },
        },
      },
    })

    await emitAuditEvent(prisma, {
      actorContext,
      action: 'team.created' as Parameters<typeof emitAuditEvent>[1]['action'],
      resourceType: 'team',
      resourceId: team.id,
      outcome: 'success',
    })

    return reply.code(201).send(createApiResponse({
      id: team.id,
      name: team.name,
      projectId: team.projectId,
      createdAt: team.createdAt.toISOString(),
    }))
  })

  app.post('/api/teams/:teamId/members', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireOwner(actorContext, reply)) return reply
    if (!requireLocalMembershipManagement(config.mode, reply)) return reply

    const { teamId } = request.params as { teamId: string }
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

    const team = await prisma.team.findUnique({
      where: { id: teamId },
      include: { project: true },
    })
    if (
      !team
      || team.systemManaged
      || team.project.channelRoot
      || team.project.organizationId !== actorContext.tenant.organizationId
    ) {
      sendApiError(reply, 404, 'NOT_FOUND', 'Team not found')
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

    await prisma.teamMember.create({
      data: {
        teamId,
        userId: body.userId,
        role,
      },
    })

    return reply.code(201).send(createApiResponse({ ok: true }))
  })

  app.patch('/api/teams/:teamId/settings', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    const roles = actorContext.actor.roles ?? []
    if (!roles.includes('owner') && !roles.includes('admin')) {
      sendApiError(reply, 403, 'FORBIDDEN', 'Owner or admin access required')
      return reply
    }

    const body = parseInput(UpdateTeamSettingsBodySchema, request.body, reply)
    if (!body) return reply
    if (!isCallLinkProviderConfigured(body.callProvider)) {
      sendApiError(
        reply,
        409,
        'PROVIDER_NOT_CONFIGURED',
        `The ${body.callProvider} call provider is not configured`,
      )
      return reply
    }

    const { teamId } = request.params as { teamId: string }
    const team = await prisma.team.findFirst({
      where: {
        id: teamId,
        project: { organizationId: actorContext.tenant.organizationId },
      },
      select: { id: true },
    })
    if (!team) {
      sendApiError(reply, 404, 'NOT_FOUND', 'Team not found')
      return reply
    }

    const updated = await prisma.team.update({
      where: { id: team.id },
      data: { callProvider: body.callProvider },
      select: { id: true, callProvider: true },
    })
    return createApiResponse(updated)
  })
}
