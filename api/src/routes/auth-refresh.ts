import type { FastifyInstance } from 'fastify'
import { MeResponseSchema, type UoaSessionIdentity } from '@nessie/schemas'

import { type SessionTokenClaims, verifySessionToken } from '../auth/session.js'
import { createApiResponse, sendApiError } from '../lib/api.js'
import { clearRefreshCookie, readRefreshCookie, setRefreshCookie } from '../lib/refresh-cookie.js'
import { buildMeResponse } from '../services/auth.js'
import { resolveExternalWorkspaceSelection } from '../services/identity-display.js'
import {
  consumeRefreshToken,
  revokeRefreshTokenByRaw,
  UoaRefreshBindingError,
} from '../services/refresh-token.js'
import {
  advanceUoaLocalSessionBindingInTransaction,
  resolveUoaLocalSessionContext,
  UoaLocalSessionBindingError,
  type UoaLocalSessionContext,
} from '../services/uoa-session-context.js'
import {
  refreshUoaSession,
  UoaSessionRefreshError,
} from '../services/uoa-session.js'
import type { RouteDeps } from './types.js'

export const registerAuthRefreshRoute = (
  app: FastifyInstance,
  deps: RouteDeps,
): void => {
  const { authSecret, buildLocalSession, buildSessionForUser, config, prisma } = deps

  app.post('/api/auth/refresh', { config: { public: true } }, async (request, reply) => {
    const rawToken = readRefreshCookie(request)
    if (!rawToken) {
      sendApiError(reply, 401, 'NO_REFRESH_TOKEN', 'No refresh token')
      return reply
    }

    let consumed: Awaited<ReturnType<typeof consumeRefreshToken>>
    try {
      consumed = await consumeRefreshToken(prisma, {
        authSecret,
        rawToken,
        ttlSeconds: config.auth.refreshTokenTtlSeconds,
        userAgent: request.headers['user-agent'] ?? null,
        refreshUoaSession: async (upstream, transaction) => {
          const refreshed = await refreshUoaSession(upstream)
          const selected = resolveExternalWorkspaceSelection(
            refreshed.identity.workspace,
          )
          if (!selected.organizationId || !selected.teamId) {
            throw new UoaRefreshBindingError(
              'UnlikeOtherAI did not return the bound session workspace.',
            )
          }
          const nextIdentity: UoaSessionIdentity = {
            organizationId: selected.organizationId,
            subject: refreshed.identity.externalSubject,
            teamId: selected.teamId,
            tokenVersion: refreshed.identity.uoaTokenVersion,
          }
          await advanceUoaLocalSessionBindingInTransaction(transaction, {
            nextIdentity,
            previousIdentity: upstream.expectedIdentity,
            userId: upstream.userId,
          })
          return {
            identity: nextIdentity,
            refreshToken: refreshed.refreshToken,
            refreshTokenExpiresAt: new Date(
              Date.now() + refreshed.refreshTokenExpiresInSeconds * 1000,
            ),
          }
        },
      })
    } catch (error) {
      const definitive =
        error instanceof UoaRefreshBindingError
        || error instanceof UoaLocalSessionBindingError
        || (error instanceof UoaSessionRefreshError && error.definitive)
      if (definitive) {
        await revokeRefreshTokenByRaw(prisma, rawToken)
        clearRefreshCookie(reply, config)
        sendApiError(
          reply,
          401,
          'REFRESH_REAUTH_REQUIRED',
          'Sign in again to renew this UnlikeOtherAI session.',
        )
        return reply
      }
      if (error instanceof UoaSessionRefreshError) {
        sendApiError(
          reply,
          503,
          'SSO_REFRESH_UNAVAILABLE',
          'UnlikeOtherAI session renewal is temporarily unavailable. Try again.',
        )
        return reply
      }
      throw error
    }
    if (!consumed.ok) {
      clearRefreshCookie(reply, config)
      sendApiError(reply, 401, 'REFRESH_INVALID', 'Refresh token is invalid or expired')
      return reply
    }

    let uoaContext: UoaLocalSessionContext | undefined
    if (consumed.uoaIdentity) {
      try {
        uoaContext = await resolveUoaLocalSessionContext(prisma, {
          identity: consumed.uoaIdentity,
          userId: consumed.userId,
        })
      } catch (error) {
        if (!(error instanceof UoaLocalSessionBindingError)) throw error
        await revokeRefreshTokenByRaw(prisma, rawToken)
        clearRefreshCookie(reply, config)
        sendApiError(
          reply,
          401,
          'REFRESH_REAUTH_REQUIRED',
          'Sign in again to renew this UnlikeOtherAI session.',
        )
        return reply
      }
    }

    const user = await prisma.user.findUnique({ where: { id: consumed.userId } })
    if (!user) {
      clearRefreshCookie(reply, config)
      sendApiError(reply, 401, 'USER_NOT_FOUND', 'User no longer exists')
      return reply
    }
    const session = uoaContext && consumed.uoaIdentity
      ? buildSessionForUser({
          organizationId: uoaContext.organizationId,
          projectId: uoaContext.projectId,
          providerId: consumed.providerId,
          providerType: consumed.providerType as SessionTokenClaims['providerType'],
          roles: [uoaContext.role],
          sessionId: consumed.sessionId,
          teamId: uoaContext.teamId,
          uoaIdentity: consumed.uoaIdentity,
          userId: consumed.userId,
        })
      : await buildLocalSession(
          consumed.userId,
          [],
          {
            providerId: consumed.providerId,
            providerType: consumed.providerType as SessionTokenClaims['providerType'],
          },
          consumed.sessionId,
        )
    const verification = verifySessionToken(session.token, authSecret)
    if (!verification.ok) {
      sendApiError(reply, 500, 'TOKEN_INVALID', 'Failed to issue session')
      return reply
    }
    const remainingTtlSeconds = Math.max(
      1,
      Math.ceil((consumed.expiresAt.getTime() - Date.now()) / 1000),
    )
    setRefreshCookie(reply, consumed.rawToken, config, remainingTtlSeconds)
    return createApiResponse({
      token: session.token,
      me: MeResponseSchema.parse(
        await buildMeResponse(prisma, user, verification.claims, config),
      ),
    })
  })
}
