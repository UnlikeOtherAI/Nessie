import type { FastifyInstance, FastifyRequest } from 'fastify'
import { MeResponseSchema } from '@nessie/schemas'

import { hashPassword, verifyPassword } from '../auth/password.js'
import { verifySessionToken } from '../auth/session.js'
import { ChangePasswordRequestSchema } from '../contracts.js'
import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import { clearRefreshCookie } from '../lib/refresh-cookie.js'
import { buildMeResponse } from '../services/auth.js'
import { clearPushSurfacePresenceForUser } from '../services/push-surface-presence.js'
import {
  listUserSessions,
  revokeUserRefreshFamilies,
  revokeUserSession,
} from '../services/refresh-session-management.js'
import {
  AUTH_LOCK_TRANSACTION_OPTIONS,
  lockUserSessions,
} from '../services/user-session-lock.js'
import { guardAuthRequest, RATE_LIMIT_BUCKETS } from './auth-rate-limit.js'
import type { IssueRefreshCookie } from './auth-shared.js'
import type { RouteDeps } from './types.js'

export const registerAuthSecurityRoutes = (
  app: FastifyInstance,
  deps: RouteDeps,
  issueRefreshCookie: IssueRefreshCookie,
): void => {
  const {
    authSecret,
    buildSessionForUser,
    config,
    getAuthorizationToken,
    prisma,
    rateLimiter,
    requireActorContext,
  } = deps
  const currentSessionId = (request: FastifyRequest): string | null => {
    const token = getAuthorizationToken(request)
    if (!token) return null
    const verification = verifySessionToken(token, authSecret)
    return verification.ok ? verification.claims.sid : null
  }

  app.get('/api/auth/sessions', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    const sessions = await listUserSessions(prisma, actorContext.actor.actorId)
    const currentSid = currentSessionId(request)
    return createApiResponse(sessions.map((session) => ({
      sessionId: session.sessionId,
      userAgent: session.userAgent,
      createdAt: session.createdAt.toISOString(),
      lastUsedAt: session.lastUsedAt.toISOString(),
      expiresAt: session.expiresAt.toISOString(),
      current: session.sessionId === currentSid,
    })))
  })

  app.delete('/api/auth/sessions/:sessionId', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    const { sessionId } = request.params as { sessionId: string }
    const revoked = await revokeUserSession(prisma, actorContext.actor.actorId, sessionId)
    if (revoked === 0) {
      sendApiError(reply, 404, 'SESSION_NOT_FOUND', 'No such active session')
      return reply
    }
    await clearPushSurfacePresenceForUser(prisma, actorContext.actor.actorId)
    if (currentSessionId(request) === sessionId) clearRefreshCookie(reply, config)
    return createApiResponse({ revoked })
  })

  app.post('/api/auth/password', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    const body = parseInput(ChangePasswordRequestSchema, request.body, reply)
    if (!body) return reply
    const userId = actorContext.actor.actorId
    // Step-up verification (current-password re-proof) is a brute-force
    // surface: cap attempts per IP and per account, keyed to the actor.
    if (
      !(await guardAuthRequest(
        rateLimiter,
        { bucket: RATE_LIMIT_BUCKETS.stepUpIp, rule: config.api.rateLimit.stepUpIp },
        request,
        reply,
        {
          account: {
            bucket: RATE_LIMIT_BUCKETS.stepUpAccount,
            rule: config.api.rateLimit.stepUpAccount,
          },
          accountIdentity: userId,
          auditContext: actorContext,
        },
      ))
    ) {
      return reply
    }
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { passwordHash: true },
    })
    if (!user?.passwordHash) {
      sendApiError(reply, 400, 'PASSWORD_NOT_SUPPORTED', 'This account does not use a password')
      return reply
    }
    if (!(await verifyPassword(body.currentPassword, user.passwordHash))) {
      sendApiError(reply, 400, 'INVALID_PASSWORD', 'Current password is incorrect')
      return reply
    }

    const currentSid = currentSessionId(request)
    const newPasswordHash = await hashPassword(body.newPassword)
    try {
      await prisma.$transaction(async (tx) => {
        await lockUserSessions(tx, userId)
        const lockedUser = await tx.user.findUnique({
          where: { id: userId },
          select: { passwordHash: true },
        })
        if (lockedUser?.passwordHash !== user.passwordHash) {
          throw new Error('PASSWORD_STATE_CHANGED')
        }
        await tx.user.update({
          where: { id: userId },
          data: { passwordHash: newPasswordHash },
        })
        await revokeUserRefreshFamilies(tx, {
          exceptSessionId: currentSid,
          userId,
        })
      }, AUTH_LOCK_TRANSACTION_OPTIONS)
    } catch (error) {
      if (error instanceof Error && error.message === 'PASSWORD_STATE_CHANGED') {
        sendApiError(
          reply,
          409,
          'PASSWORD_STATE_CHANGED',
          'Password changed concurrently; try again',
        )
        return reply
      }
      throw error
    }
    return createApiResponse({ ok: true })
  })

  app.post('/api/auth/switch-context', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    const body = request.body as {
      organizationId?: string
      projectId?: string
      teamId?: string
    } | undefined
    if (!body?.organizationId || !body.projectId || !body.teamId) {
      sendApiError(
        reply,
        400,
        'INVALID_INPUT',
        'organizationId, projectId, and teamId are required',
      )
      return reply
    }
    const { organizationId, projectId, teamId } = body
    const userId = actorContext.actor.actorId
    const orgMember = await prisma.organizationMember.findUnique({
      where: { organizationId_userId: { organizationId, userId } },
    })
    if (!orgMember) {
      sendApiError(reply, 403, 'NOT_A_MEMBER', 'Not a member of this organization')
      return reply
    }
    if (orgMember.deactivatedAt) {
      sendApiError(
        reply,
        403,
        'ACCOUNT_DEACTIVATED',
        'Your access to this organisation has been deactivated',
      )
      return reply
    }
    const project = await prisma.project.findUnique({ where: { id: projectId } })
    const projectMember = await prisma.projectMember.findUnique({
      where: { projectId_userId: { projectId, userId } },
    })
    const team = await prisma.team.findUnique({ where: { id: teamId } })
    const teamMember = await prisma.teamMember.findUnique({
      where: { teamId_userId: { teamId, userId } },
    })
    if (
      !project
      || project.organizationId !== organizationId
      || !projectMember
      || !team
      || team.projectId !== projectId
      || !teamMember
    ) {
      sendApiError(reply, 403, 'NOT_A_MEMBER', 'Not a member of this project/team')
      return reply
    }

    const currentToken = getAuthorizationToken(request)
    const currentVerification = currentToken
      ? verifySessionToken(currentToken, authSecret)
      : null
    if (!currentVerification?.ok) {
      sendApiError(reply, 401, 'AUTH_REQUIRED', 'Authentication required')
      return reply
    }
    const currentClaims = currentVerification.claims
    if (
      currentClaims.providerType === 'uoa'
      && (
        !currentClaims.uoaIdentity
        || team.externalOrgId !== currentClaims.uoaIdentity.organizationId
        || team.externalWorkspaceId !== currentClaims.uoaIdentity.teamId
      )
    ) {
      sendApiError(
        reply,
        409,
        'SSO_WORKSPACE_REAUTH_REQUIRED',
        'Sign in with UnlikeOtherAI to switch to this workspace.',
      )
      return reply
    }
    const session = await buildSessionForUser({
      organizationId,
      projectId,
      providerId: currentClaims.providerId,
      providerType: currentClaims.providerType,
      roles: [orgMember.role],
      sessionId: currentClaims.providerType === 'uoa' ? currentClaims.sid : undefined,
      teamId,
      uoaIdentity: currentClaims.uoaIdentity,
      userId,
    })
    const verification = verifySessionToken(session.token, authSecret)
    if (!verification.ok) {
      sendApiError(reply, 500, 'TOKEN_INVALID', 'Failed to issue new session')
      return reply
    }
    const user = await prisma.user.findUnique({ where: { id: userId } })
    if (!user) {
      sendApiError(reply, 500, 'USER_NOT_FOUND', 'User not found')
      return reply
    }
    if (verification.claims.providerType !== 'uoa') {
      await issueRefreshCookie(request, reply, {
        userId,
        organizationId: verification.claims.org,
        sessionId: session.sessionId,
        providerId: verification.claims.providerId,
        providerType: verification.claims.providerType,
      })
    }
    return createApiResponse({
      token: session.token,
      me: MeResponseSchema.parse(
        await buildMeResponse(prisma, user, verification.claims, config),
      ),
    })
  })
}
