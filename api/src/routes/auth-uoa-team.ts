import type { FastifyInstance } from 'fastify'

import { verifySessionToken } from '../auth/session.js'
import { UoaTeamSwitchRequestSchema } from '../contracts/auth.js'
import { parseInput, sendApiError } from '../lib/api.js'
import { clearRefreshCookie, readRefreshCookie } from '../lib/refresh-cookie.js'
import {
  consumeRefreshToken,
  revokeRefreshTokenByRaw,
  UoaRefreshBindingError,
  UoaTeamSwitchError,
} from '../services/refresh-token.js'
import { hashRefreshToken } from '../services/refresh-token-crypto.js'
import { createUoaRefreshCallbacks } from '../services/uoa-refresh-coordinator.js'
import { UoaLocalSessionBindingError } from '../services/uoa-session-context.js'
import { UoaSessionRefreshError } from '../services/uoa-session.js'
import {
  parseSessionClientType,
  SESSION_CLIENT_HEADER,
} from '../services/session-client.js'
import { guardAuthRequest, RATE_LIMIT_BUCKETS } from './auth-rate-limit.js'
import { completeConsumedAuthSession } from './auth-session-completion.js'
import type { RouteDeps } from './types.js'

const sendSwitchFailure = (
  reply: Parameters<typeof sendApiError>[0],
  error: UoaTeamSwitchError,
): unknown => sendApiError(
  reply,
  error.code === 'TEAM_SWITCH_CONFLICT' ? 409 : 403,
  error.code,
  error.code === 'INTERACTION_REQUIRED'
    ? 'Sign in again to access the requested UnlikeOtherAI team.'
    : error.code === 'TEAM_NOT_AVAILABLE'
      ? 'That UnlikeOtherAI team is not available for Nessie.'
      : 'The team switch conflicted with another session rotation. Try again.',
)

export const registerAuthUoaTeamRoute = (
  app: FastifyInstance,
  deps: RouteDeps,
): void => {
  const {
    authSecret,
    config,
    getAuthorizationToken,
    prisma,
    rateLimiter,
    requireActorContext,
  } = deps

  app.post('/api/auth/uoa/team', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    const body = parseInput(UoaTeamSwitchRequestSchema, request.body, reply)
    if (!body) return reply
    const bearer = getAuthorizationToken(request)
    const verification = bearer ? verifySessionToken(bearer, authSecret) : null
    const source = verification?.ok ? verification.claims : null
    if (
      !source
      || source.providerType !== 'uoa'
      || !source.uoaIdentity
      || source.uoaIdentity.tokenVersion === null
      || source.sub !== actorContext.actor.actorId
    ) {
      sendApiError(
        reply,
        403,
        'INTERACTION_REQUIRED',
        'Sign in with UnlikeOtherAI before switching its team.',
      )
      return reply
    }
    const rawToken = readRefreshCookie(request)
    if (!rawToken) {
      sendApiError(reply, 401, 'NO_REFRESH_TOKEN', 'No refresh token')
      return reply
    }
    if (!(await guardAuthRequest(
      rateLimiter,
      { bucket: RATE_LIMIT_BUCKETS.refreshIp, rule: config.api.rateLimit.refreshIp },
      request,
      reply,
    ))) return reply
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
    ) return reply

    let consumed: Awaited<ReturnType<typeof consumeRefreshToken>>
    try {
      consumed = await consumeRefreshToken(prisma, {
        authSecret,
        rawToken,
        ttlSeconds: config.auth.refreshTokenTtlSeconds,
        userAgent: request.headers['user-agent'] ?? null,
        clientType: parseSessionClientType(request.headers[SESSION_CLIENT_HEADER]),
        uoaTeamSwitch: {
          sourceIdentity: source.uoaIdentity,
          sourceProviderId: source.providerId,
          sourceSessionId: source.sid,
          sourceUserId: source.sub,
          target: body,
        },
        ...createUoaRefreshCallbacks(prisma),
      })
    } catch (error) {
      if (error instanceof UoaTeamSwitchError) {
        sendSwitchFailure(reply, error)
        return reply
      }
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
          'TEAM_SWITCH_REAUTH_REQUIRED',
          'Sign in again before switching UnlikeOtherAI teams.',
        )
        return reply
      }
      if (error instanceof UoaSessionRefreshError) {
        sendApiError(
          reply,
          503,
          'TEAM_SWITCH_UNAVAILABLE',
          'UnlikeOtherAI team switching is temporarily unavailable. Try again.',
        )
        return reply
      }
      throw error
    }
    if (!consumed.ok) {
      clearRefreshCookie(reply, config)
      sendApiError(
        reply,
        401,
        'TEAM_SWITCH_REAUTH_REQUIRED',
        'Sign in again before switching UnlikeOtherAI teams.',
      )
      return reply
    }
    return completeConsumedAuthSession(deps, reply, {
      consumed,
      presentedRawToken: rawToken,
    })
  })
}
