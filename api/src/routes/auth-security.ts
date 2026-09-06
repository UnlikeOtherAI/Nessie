import type { FastifyInstance, FastifyRequest } from 'fastify'
import { MeResponseSchema, SessionSummarySchema } from '@nessie/schemas'

import { hashPassword, verifyPassword } from '../auth/password.js'
import { verifySessionToken } from '../auth/session.js'
import { ChangePasswordRequestSchema, SwitchContextBodySchema } from '../contracts/auth.js'
import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import { clearRefreshCookie } from '../lib/refresh-cookie.js'
import {
  ActorContextSwitchError,
  switchActorContext,
  type ActorContextSwitchErrorCode,
} from '../services/actor-context-switch.js'
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
import { guardAuthRequest, rateLimitFor } from './auth-rate-limit.js'
import type { IssueRefreshCookie } from './auth-shared.js'
import type { RouteDeps } from './types.js'

/**
 * The optimistic-concurrency refusal for a concurrent password change. A typed
 * class rather than a bare `Error` whose message doubles as its code, so
 * rewording the sentence cannot silently turn the handled 409 into a 500
 * (2026-09-05 review, S2-F4).
 */
class PasswordStateChangedError extends Error {
  readonly code = 'PASSWORD_STATE_CHANGED'

  constructor() {
    super('Password changed concurrently; try again')
    this.name = 'PasswordStateChangedError'
  }
}

/** Status for each refusal `switchActorContext` can raise. */
const SWITCH_CONTEXT_STATUS: Record<ActorContextSwitchErrorCode, number> = {
  ACCOUNT_DEACTIVATED: 403,
  NOT_A_MEMBER: 403,
  SSO_TEAM_REAUTH_REQUIRED: 409,
  // Not 4xx-as-retry: no amount of signing in makes an unlinked team openable.
  TEAM_NOT_UOA_LINKED: 409,
  USER_NOT_FOUND: 500,
}

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
    return createApiResponse(SessionSummarySchema.array().parse(sessions.map((session) => ({
      sessionId: session.sessionId,
      userAgent: session.userAgent,
      clientType: session.clientType,
      createdAt: session.createdAt.toISOString(),
      lastUsedAt: session.lastUsedAt.toISOString(),
      expiresAt: session.expiresAt.toISOString(),
      current: session.sessionId === currentSid,
    }))))
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
    // This replica just ended the session; drop its cached verdict so the very
    // next request on this process re-reads and rejects, rather than honouring
    // the access token for the remainder of the cache TTL. The NOTIFY beside
    // it does the same on every other replica, which would otherwise each wait
    // out their own TTL; a failed broadcast only costs that wait back, so it
    // never fails the request.
    deps.invalidateSessionRevocationCache?.(sessionId)
    try {
      await deps.realtimeHub.publishSessionRevocation(sessionId)
    } catch (err) {
      request.log.error({ err }, 'session_revocation_broadcast_failed')
    }
    await clearPushSurfacePresenceForUser(prisma, actorContext.actor.actorId)
    if (currentSessionId(request) === sessionId) clearRefreshCookie(reply, config)
    return createApiResponse({ revoked })
  })

  app.post('/api/auth/password', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    // No local passwords outside `local` mode, so there is nothing to change:
    // refuse before the body is read or an attempt is metered.
    if (config.mode !== 'local') {
      sendApiError(
        reply,
        403,
        'PASSWORD_AUTH_DISABLED',
        'Password sign-in is disabled on this deployment. Manage your credentials with your identity provider.',
      )
      return reply
    }
    const body = parseInput(ChangePasswordRequestSchema, request.body, reply)
    if (!body) return reply
    const userId = actorContext.actor.actorId
    // Step-up verification (current-password re-proof) is a brute-force
    // surface: cap attempts per IP and per account, keyed to the actor.
    if (
      !(await guardAuthRequest(
        rateLimiter,
        rateLimitFor(config, 'stepUpIp'),
        request,
        reply,
        {
          account: rateLimitFor(config, 'stepUpAccount'),
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
          throw new PasswordStateChangedError()
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
      if (error instanceof PasswordStateChangedError) {
        sendApiError(reply, 409, error.code, error.message)
        return reply
      }
      throw error
    }
    return createApiResponse({ ok: true })
  })

  app.post('/api/auth/switch-context', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    const body = parseInput(SwitchContextBodySchema, request.body, reply)
    if (!body) return reply

    // The new session inherits the presenting session's provider identity, so
    // the bearer has to be re-read for its claims rather than reconstructed
    // from the actor context.
    const currentToken = getAuthorizationToken(request)
    const currentVerification = currentToken
      ? verifySessionToken(currentToken, authSecret)
      : null
    if (!currentVerification?.ok) {
      sendApiError(reply, 401, 'AUTH_REQUIRED', 'Authentication required')
      return reply
    }

    let switched: Awaited<ReturnType<typeof switchActorContext>>
    try {
      switched = await switchActorContext(prisma, {
        buildSessionForUser,
        currentClaims: currentVerification.claims,
        organizationId: body.organizationId,
        projectId: body.projectId,
        teamId: body.teamId,
        userId: actorContext.actor.actorId,
      })
    } catch (error) {
      if (error instanceof ActorContextSwitchError) {
        sendApiError(reply, SWITCH_CONTEXT_STATUS[error.code], error.code, error.message)
        return reply
      }
      throw error
    }

    const { session, user } = switched
    if (session.claims.providerType !== 'uoa') {
      await issueRefreshCookie(request, reply, {
        userId: user.id,
        organizationId: session.claims.org,
        sessionId: session.sessionId,
        providerId: session.claims.providerId,
        providerType: session.claims.providerType,
      })
    }
    return createApiResponse({
      token: session.token,
      me: MeResponseSchema.parse(
        await buildMeResponse(prisma, user, session.claims, config),
      ),
    })
  })
}
