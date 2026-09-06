import type { FastifyReply } from 'fastify'
import { MeResponseSchema } from '@nessie/schemas'

import type { SessionTokenClaims } from '../auth/session.js'
import { createApiResponse, sendApiError } from '../lib/api.js'
import { clearRefreshCookie, setRefreshCookie } from '../lib/refresh-cookie.js'
import { buildMeResponse } from '../services/auth.js'
import type { ConsumeRefreshTokenResult } from '../services/refresh-token.js'
import { revokeRefreshTokenByRaw } from '../services/refresh-token.js'
import {
  resolveUoaLocalSessionContext,
  UoaLocalSessionBindingError,
  type UoaLocalSessionContext,
} from '../services/uoa-session-context.js'
import type { RouteDeps } from './types.js'

type ConsumedSession = Extract<ConsumeRefreshTokenResult, { ok: true }>

/** Issue the common token/me/cookie response after refresh or UOA rescoping. */
export const completeConsumedAuthSession = async (
  deps: RouteDeps,
  reply: FastifyReply,
  input: {
    consumed: ConsumedSession
    presentedRawToken: string
    userAgent?: string | null
  },
): Promise<unknown> => {
  const {
    buildLocalSession,
    buildSessionForUser,
    config,
    prisma,
  } = deps
  const { consumed } = input
  let uoaContext: UoaLocalSessionContext | undefined
  if (consumed.uoaIdentity) {
    try {
      uoaContext = await resolveUoaLocalSessionContext(prisma, {
        identity: consumed.uoaIdentity,
        userId: consumed.userId,
      })
    } catch (error) {
      if (!(error instanceof UoaLocalSessionBindingError)) throw error
      await revokeRefreshTokenByRaw(prisma, input.presentedRawToken)
      clearRefreshCookie(reply, config)
      return sendApiError(
        reply,
        401,
        'REFRESH_REAUTH_REQUIRED',
        'Sign in again to renew this UnlikeOtherAI session.',
      )
    }
  }

  const user = await prisma.user.findUnique({ where: { id: consumed.userId } })
  if (!user) {
    clearRefreshCookie(reply, config)
    return sendApiError(reply, 401, 'USER_NOT_FOUND', 'User no longer exists')
  }
  const session = uoaContext && consumed.uoaIdentity
    ? await buildSessionForUser({
        organizationId: uoaContext.organizationId,
        projectId: uoaContext.projectId,
        providerId: consumed.providerId,
        providerType: consumed.providerType as SessionTokenClaims['providerType'],
        roles: [uoaContext.role],
        sessionId: consumed.sessionId,
        teamId: uoaContext.teamId,
        uoaIdentity: consumed.uoaIdentity,
        userAgent: input.userAgent,
        userId: consumed.userId,
      })
    : await buildLocalSession(
        consumed.userId,
        [],
        {
          providerId: consumed.providerId,
          providerType: consumed.providerType as SessionTokenClaims['providerType'],
        },
        { sessionId: consumed.sessionId, userAgent: input.userAgent },
      )
  const remainingTtlSeconds = Math.max(
    1,
    Math.ceil((consumed.expiresAt.getTime() - Date.now()) / 1_000),
  )
  setRefreshCookie(
    reply,
    consumed.rawToken,
    config,
    remainingTtlSeconds,
  )
  return createApiResponse({
    token: session.token,
    me: MeResponseSchema.parse(
      await buildMeResponse(prisma, user, session.claims, config),
    ),
  })
}
