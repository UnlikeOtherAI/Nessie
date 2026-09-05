import type { FastifyInstance } from 'fastify'

import { hashPassword } from '../auth/password.js'
import {
  CreateUserBodySchema,
  UpdateUserRoleBodySchema,
  UserRecordSchema,
} from '../contracts.js'
import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import { sendAvatarImage, sendAvatarNotFound } from './avatar-response.js'
import { requireUnboundMembershipManagement } from './membership-mode-gate.js'
import {
  fetchUoaUserAvatar,
  resolveUoaAvatarSubject,
  UoaAvatarUnavailableError,
} from '../services/uoa-avatar.js'
import { LAST_OWNER_ERROR } from '../services/organization-owner-lock.js'
import {
  createUserForOrganization,
  getOrganizationMembership,
  getOrganizationUserRecord,
  listUsersForOrganization,
  setOrganizationMemberDeactivated,
  updateOrganizationMemberRole,
} from '../services/users.js'
import { attemptPersonalAssistantAvatar } from '../services/personal-assistant-avatar.js'
import { ensurePersonalAssistantBootstrap } from '../services/personal-assistant.js'
import { attemptGlobalAgentsBootstrap } from '../services/global-agents.js'
import type { RouteDeps } from './types.js'

// The membership mutators throw LAST_OWNER_ERROR from inside their transaction
// (after an atomic, row-locked owner-count check); translate it to a 400.
const isLastOwnerError = (error: unknown): boolean =>
  error instanceof Error && error.message === LAST_OWNER_ERROR

export const registerUserRoutes = (app: FastifyInstance, deps: RouteDeps): void => {
  const {
    prisma,
    requireActorContext,
    requireOwner,
    resolveMembershipRole,
    MEMBERSHIP_ROLES,
  } = deps

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

    // Creating a human here also mints a local password credential, which only
    // an organisation no identity provider binds may own. Inside a UOA-bound
    // organisation UOA is the authority for who exists: people arrive through
    // SSO or an invitation. The predicate is the tenant's binding rather than
    // the deployment mode, for the reason in `membership-mode-gate.ts`
    // (2026-09-05 review, FO2-2).
    const organization = await prisma.organization.findUnique({
      where: { id: actorContext.tenant.organizationId },
      select: { externalOrgId: true },
    })
    if (organization?.externalOrgId) {
      sendApiError(
        reply,
        403,
        'LOCAL_USER_CREATION_DISABLED',
        'Local accounts are disabled in this organisation. Members join through SSO or an invitation.',
      )
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

    // Where the new member lands has to come from the caller's own session. The
    // fixed-UUID fallbacks that used to stand in here were the same literal for
    // every tenant, so a session with no project/team context wrote membership
    // rows pointing at another organisation's ids (2026-09-05 review, FO1-9);
    // `docs/architecture.md` forbids sentinel values for exactly this.
    const projectId = actorContext.tenant.projectId
    const teamId = actorContext.tenant.teamId ?? actorContext.actionContext.teamId
    if (!projectId || !teamId) {
      sendApiError(
        reply,
        400,
        'TEAM_CONTEXT_REQUIRED',
        'A project and team context is required to create a member.',
      )
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
        projectId,
        role,
        teamId,
      })

      await ensurePersonalAssistantBootstrap(prisma, {
        organizationId: actorContext.tenant.organizationId,
        teamId,
        userId: user.id,
      })
      await attemptGlobalAgentsBootstrap(
        prisma,
        { organizationId: actorContext.tenant.organizationId, teamId, userId: user.id },
        (error) => request.log.error({ err: error }, 'global_agent_bootstrap_failed'),
      )
      await attemptPersonalAssistantAvatar({
        actorContext,
        config: deps.config.model,
        fileService: deps.fileService,
        ledgerIdentity: deps.ledgerIdentity,
        modelClient: deps.sharedModelClient,
        organizationId: actorContext.tenant.organizationId,
        prisma,
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
    if (!await requireUnboundMembershipManagement(prisma, reply, {
      organizationId: actorContext.tenant.organizationId,
    })) return reply

    const body = parseInput(UpdateUserRoleBodySchema, request.body, reply)
    if (!body) return reply
    const role = resolveMembershipRole(body.role)
    if (!role) {
      sendApiError(reply, 400, 'INVALID_ROLE', `role must be one of: ${MEMBERSHIP_ROLES.join(', ')}`)
      return reply
    }

    const { userId } = request.params as { userId: string }
    const organizationId = actorContext.tenant.organizationId

    // No actor may rewrite their own role in a single call (a stale owner token
    // must not be able to re-grant or change its own membership).
    if (userId === actorContext.actor.actorId) {
      sendApiError(reply, 400, 'CANNOT_CHANGE_OWN_ROLE', 'You cannot change your own role')
      return reply
    }

    const membership = await getOrganizationMembership(prisma, organizationId, userId)
    if (!membership) {
      sendApiError(reply, 404, 'MEMBER_NOT_FOUND', 'No such member in this organisation')
      return reply
    }

    // The last-active-owner guard is enforced atomically inside the service
    // transaction (row-locked) and surfaces as LAST_OWNER_ERROR.
    try {
      await updateOrganizationMemberRole(prisma, { organizationId, userId, role })
    } catch (error) {
      if (isLastOwnerError(error)) {
        sendApiError(reply, 400, 'LAST_OWNER', 'Cannot demote the last active owner')
        return reply
      }
      throw error
    }
    const updated = await getOrganizationUserRecord(prisma, organizationId, userId)
    return createApiResponse(UserRecordSchema.parse(updated))
  })

  app.post('/api/users/:userId/deactivate', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireOwner(actorContext, reply)) return reply
    if (!await requireUnboundMembershipManagement(prisma, reply, {
      organizationId: actorContext.tenant.organizationId,
    })) return reply

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

    // Last-active-owner guard is enforced atomically inside the service.
    try {
      await setOrganizationMemberDeactivated(prisma, {
        actorUserId: actorContext.actor.actorId,
        deactivated: true,
        organizationId,
        requestId: actorContext.actionContext.requestId,
        userId,
      })
    } catch (error) {
      if (isLastOwnerError(error)) {
        sendApiError(reply, 400, 'LAST_OWNER', 'Cannot deactivate the last active owner')
        return reply
      }
      throw error
    }
    const updated = await getOrganizationUserRecord(prisma, organizationId, userId)
    return createApiResponse(UserRecordSchema.parse(updated))
  })

  app.post('/api/users/:userId/reactivate', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireOwner(actorContext, reply)) return reply
    if (!await requireUnboundMembershipManagement(prisma, reply, {
      organizationId: actorContext.tenant.organizationId,
    })) return reply

    const { userId } = request.params as { userId: string }
    const organizationId = actorContext.tenant.organizationId
    const membership = await getOrganizationMembership(prisma, organizationId, userId)
    if (!membership) {
      sendApiError(reply, 404, 'MEMBER_NOT_FOUND', 'No such member in this organisation')
      return reply
    }

    await setOrganizationMemberDeactivated(prisma, {
      actorUserId: actorContext.actor.actorId,
      deactivated: false,
      organizationId,
      requestId: actorContext.actionContext.requestId,
      userId,
    })
    const updated = await getOrganizationUserRecord(prisma, organizationId, userId)
    return createApiResponse(UserRecordSchema.parse(updated))
  })

  /**
   * Relay a member's UnlikeOtherAuthenticator avatar. UOA's avatar endpoint is
   * authenticated with a server-side domain-hash secret, so the browser cannot
   * fetch it directly; the API resolves the caller-visible UOA subject and
   * streams the bytes back.
   *
   * Any authenticated actor may read any avatar in their own organization —
   * avatars render everywhere, and the `ProductAccountLink` lookup is already
   * organization-scoped. A user who never linked (or a deployment with no UOA)
   * is a 404, which the client treats as "no such source" and falls through to
   * its provider/Gravatar/initials chain.
   */
  app.get('/api/users/:userId/avatar', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    const { userId } = request.params as { userId: string }
    const uoaSub = await resolveUoaAvatarSubject(prisma, {
      organizationId: actorContext.tenant.organizationId,
      userId,
    })

    let image = null
    try {
      image = uoaSub ? await fetchUoaUserAvatar(uoaSub) : null
    } catch (error) {
      if (error instanceof UoaAvatarUnavailableError) {
        request.log.warn({ err: error, userId }, 'uoa avatar relay failed')
        sendApiError(
          reply,
          502,
          'UOA_AVATAR_UNAVAILABLE',
          'The UnlikeOtherAI avatar service is temporarily unavailable',
        )
        return reply
      }
      throw error
    }

    if (!image) {
      return sendAvatarNotFound(reply, 'This user has no UnlikeOtherAI avatar')
    }
    return sendAvatarImage(reply, image)
  })
}
