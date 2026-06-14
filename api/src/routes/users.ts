import type { FastifyInstance } from 'fastify'

import { hashPassword } from '../auth/password.js'
import {
  CreateUserBodySchema,
  UpdateUserRoleBodySchema,
  UserRecordSchema,
} from '../contracts.js'
import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import {
  countActiveOwners,
  createUserForOrganization,
  getOrganizationMembership,
  getOrganizationUserRecord,
  listUsersForOrganization,
  setOrganizationMemberDeactivated,
  updateOrganizationMemberRole,
} from '../services/users.js'
import type { RouteDeps } from './types.js'

export const registerUserRoutes = (app: FastifyInstance, deps: RouteDeps): void => {
  const { prisma, requireActorContext, requireOwner, resolveMembershipRole, MEMBERSHIP_ROLES } = deps

  app.get('/api/users', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    if (!requireOwner(actorContext, reply)) {
      return reply
    }

    const users = await listUsersForOrganization(prisma, actorContext.tenant.organizationId)
    return createApiResponse(UserRecordSchema.array().parse(users))
  })

  app.post('/api/users', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    if (!requireOwner(actorContext, reply)) {
      return reply
    }

    const body = parseInput(CreateUserBodySchema, request.body, reply)
    if (!body) {
      return reply
    }

    const role = resolveMembershipRole(body.role)
    if (!role) {
      sendApiError(reply, 400, 'INVALID_ROLE', `role must be one of: ${MEMBERSHIP_ROLES.join(', ')}`)
      return reply
    }

    try {
      const passwordHash = await hashPassword(body.password)
      const user = await createUserForOrganization(prisma, {
        channelIds: body.channelIds,
        displayName: body.displayName,
        email: body.email,
        organizationId: actorContext.tenant.organizationId,
        passwordHash,
        projectId:
          actorContext.tenant.projectId ??
          '00000000-0000-4000-8000-000000000002',
        role,
        teamId:
          actorContext.tenant.teamId ??
          actorContext.actionContext.teamId ??
          '00000000-0000-4000-8000-000000000003',
      })

      return reply.code(201).send(createApiResponse(UserRecordSchema.parse(user)))
    } catch (error) {
      if (error instanceof Error && error.message === 'USER_ALREADY_EXISTS') {
        sendApiError(reply, 409, 'USER_ALREADY_EXISTS', 'A user with that email already exists')
        return reply
      }

      throw error
    }
  })

  app.patch('/api/users/:userId', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireOwner(actorContext, reply)) return reply

    const body = parseInput(UpdateUserRoleBodySchema, request.body, reply)
    if (!body) return reply
    const role = resolveMembershipRole(body.role)
    if (!role) {
      sendApiError(reply, 400, 'INVALID_ROLE', `role must be one of: ${MEMBERSHIP_ROLES.join(', ')}`)
      return reply
    }

    const { userId } = request.params as { userId: string }
    const organizationId = actorContext.tenant.organizationId
    const membership = await getOrganizationMembership(prisma, organizationId, userId)
    if (!membership) {
      sendApiError(reply, 404, 'MEMBER_NOT_FOUND', 'No such member in this organisation')
      return reply
    }

    // Never demote the last active owner out of ownership — it would lock
    // everyone out of org administration.
    if (membership.role === 'owner' && role !== 'owner') {
      if ((await countActiveOwners(prisma, organizationId)) <= 1) {
        sendApiError(reply, 400, 'LAST_OWNER', 'Cannot demote the last active owner')
        return reply
      }
    }

    await updateOrganizationMemberRole(prisma, { organizationId, userId, role })
    const updated = await getOrganizationUserRecord(prisma, organizationId, userId)
    return createApiResponse(UserRecordSchema.parse(updated))
  })

  app.post('/api/users/:userId/deactivate', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireOwner(actorContext, reply)) return reply

    const { userId } = request.params as { userId: string }
    const organizationId = actorContext.tenant.organizationId

    if (userId === actorContext.actor.actorId) {
      sendApiError(reply, 400, 'CANNOT_DEACTIVATE_SELF', 'You cannot deactivate your own membership')
      return reply
    }

    const membership = await getOrganizationMembership(prisma, organizationId, userId)
    if (!membership) {
      sendApiError(reply, 404, 'MEMBER_NOT_FOUND', 'No such member in this organisation')
      return reply
    }
    if (membership.role === 'owner' && (await countActiveOwners(prisma, organizationId)) <= 1) {
      sendApiError(reply, 400, 'LAST_OWNER', 'Cannot deactivate the last active owner')
      return reply
    }

    await setOrganizationMemberDeactivated(prisma, { organizationId, userId, deactivated: true })
    const updated = await getOrganizationUserRecord(prisma, organizationId, userId)
    return createApiResponse(UserRecordSchema.parse(updated))
  })

  app.post('/api/users/:userId/reactivate', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireOwner(actorContext, reply)) return reply

    const { userId } = request.params as { userId: string }
    const organizationId = actorContext.tenant.organizationId
    const membership = await getOrganizationMembership(prisma, organizationId, userId)
    if (!membership) {
      sendApiError(reply, 404, 'MEMBER_NOT_FOUND', 'No such member in this organisation')
      return reply
    }

    await setOrganizationMemberDeactivated(prisma, { organizationId, userId, deactivated: false })
    const updated = await getOrganizationUserRecord(prisma, organizationId, userId)
    return createApiResponse(UserRecordSchema.parse(updated))
  })
}
