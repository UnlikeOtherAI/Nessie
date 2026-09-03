import type { FastifyInstance } from 'fastify'
import { sendApiError } from '../lib/api.js'
import { clearRefreshCookie, readRefreshCookie } from '../lib/refresh-cookie.js'
import { hashRefreshToken } from '../services/refresh-token-crypto.js'
import {
  consumeRefreshToken,
  revokeRefreshTokenByRaw,
  UoaRefreshBindingError,
  UoaWorkspaceSwitchError,
} from '../services/refresh-token.js'
import { UoaUnrecognizedRoleError } from '../services/uoa-roles.js'
import {
  UoaLocalSessionBindingError,
} from '../services/uoa-session-context.js'
import { createUoaRefreshCallbacks } from '../services/uoa-refresh-coordinator.js'
import {
  UoaSessionRefreshError,
} from '../services/uoa-session.js'
import {
  parseSessionClientType,
  SESSION_CLIENT_HEADER,
} from '../services/session-client.js'
import { guardAuthRequest, RATE_LIMIT_BUCKETS } from './auth-rate-limit.js'
import { completeConsumedAuthSession } from './auth-session-completion.js'
import type { RouteDeps } from './types.js'

export const registerAuthRefreshRoute = (
  app: FastifyInstance,
  deps: RouteDeps,
): void => {
  const {
    authSecret,
    config,
    prisma,
    rateLimiter,
  } = deps

  app.post('/api/auth/refresh', { config: { public: true } }, async (request, reply) => {
    const rawToken = readRefreshCookie(request)
    if (!rawToken) {
      sendApiError(reply, 401, 'NO_REFRESH_TOKEN', 'No refresh token')
      return reply
    }
    // Brute-force guard on the token-consumption surface: per-IP up front;
    // the per-account counter binds to the resolved user once the presented
    // token identifies a session, so stolen-cookie sprays converge on one
    // account bucket regardless of source IP.
    if (
      !(await guardAuthRequest(
        rateLimiter,
        {
          bucket: RATE_LIMIT_BUCKETS.refreshIp,
          rule: config.api.rateLimit.refreshIp,
        },
        request,
        reply,
      ))
    ) {
      return reply
    }
    // Resolve the presented token's owner up front so the per-account
    // counter binds to the credential itself, before any rotation work runs.
    const tokenHint = await prisma.refreshToken.findUnique({
      where: { tokenHash: hashRefreshToken(rawToken) },
      select: { userId: true },
    })
    if (
      tokenHint
      && !(await guardAuthRequest(
        rateLimiter,
        {
          bucket: RATE_LIMIT_BUCKETS.refreshAccount,
          rule: config.api.rateLimit.refreshAccount,
        },
        request,
        reply,
        { accountIdentity: tokenHint.userId },
      ))
    ) {
      return reply
    }

    let consumed: Awaited<ReturnType<typeof consumeRefreshToken>>
    try {
      consumed = await consumeRefreshToken(prisma, {
        authSecret,
        rawToken,
        ttlSeconds: config.auth.refreshTokenTtlSeconds,
        userAgent: request.headers['user-agent'] ?? null,
        clientType: parseSessionClientType(request.headers[SESSION_CLIENT_HEADER]),
        ...createUoaRefreshCallbacks(prisma),
      })
    } catch (error) {
      if (error instanceof UoaWorkspaceSwitchError) {
        const statusCode = error.code === 'WORKSPACE_SWITCH_CONFLICT' ? 409 : 403
        sendApiError(
          reply,
          statusCode,
          error.code,
          error.code === 'INTERACTION_REQUIRED'
            ? 'Sign in again to access the requested UnlikeOtherAI workspace.'
            : 'The pending UnlikeOtherAI workspace switch could not be completed.',
        )
        return reply
      }
      // An unrecognised role claim is definitive, not transient: renewing the
      // session would have to project a standing Nessie cannot express, so the
      // family is revoked and the person re-authenticates instead.
      const definitive =
        error instanceof UoaRefreshBindingError
        || error instanceof UoaLocalSessionBindingError
        || error instanceof UoaUnrecognizedRoleError
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

    return completeConsumedAuthSession(deps, reply, {
      consumed,
      presentedRawToken: rawToken,
      userAgent: request.headers['user-agent'] ?? null,
    })
  })
}
