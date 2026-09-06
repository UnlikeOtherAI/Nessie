import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { PrismaClient } from '@prisma/client'

import { verifySessionTokenForLogout } from '../auth/session.js'
import { readRefreshCookie } from '../lib/refresh-cookie.js'
import { clearPushSurfacePresenceForUser } from '../services/push-surface-presence.js'
import { revokeRefreshTokenByRaw } from '../services/refresh-token.js'
import { revokeUserSession } from '../services/refresh-session-management.js'

type LogoutDeps = {
  authSecret: string
  getAuthorizationToken: (request: FastifyRequest) => string | null
  prisma: PrismaClient
}

type LogoutOperations = {
  clearPresence: typeof clearPushSurfacePresenceForUser
  revokeByRefreshToken: typeof revokeRefreshTokenByRaw
  revokeSession: typeof revokeUserSession
}

const defaultOperations: LogoutOperations = {
  clearPresence: clearPushSurfacePresenceForUser,
  revokeByRefreshToken: revokeRefreshTokenByRaw,
  revokeSession: revokeUserSession,
}

/**
 * Sign out.
 *
 * The refresh cookie — not the 30-minute access token — is the durable
 * credential: `POST /api/auth/refresh` accepts it on its own. Logout used to
 * authenticate only by bearer and, when that was missing or unverifiable, do
 * nothing at all and answer 204 — so a browser whose SPA had already discarded
 * its access token (the ordinary case: a tab left idle past the 30-minute
 * access TTL) was told it had signed out while still holding a live 30-day
 * cookie that minted fresh sessions on the next refresh (2026-09-05 review,
 * FO3-4). Now the presented cookie's own family is revoked instead, so the
 * credential is dead server-side whatever the browser still holds.
 *
 * It still sends no cookie-clear header, which is deliberate and unchanged:
 * a delayed logout response from an older app instance must never erase a
 * newer login's same-name cookie (see
 * docs/deployment-modes-and-auth-spec/authentication.md → revocation). It does
 * not need to — the browser attaches the cookie value that existed when the
 * request was SENT, so the family revoked here is always the presenting one,
 * and a now-worthless cookie is cleared by `POST /api/auth/refresh` on its
 * next 401.
 *
 * 204 either way: logout is idempotent, and telling an unauthenticated caller
 * whether a cookie was live is information it has no reason to have.
 */
export const registerAuthLogoutRoute = (
  app: FastifyInstance,
  deps: LogoutDeps,
  operations: LogoutOperations = defaultOperations,
): void => {
  app.delete('/api/auth/session', { config: { public: true } }, async (request, reply) => {
    const bearer = deps.getAuthorizationToken(request)
    const verification = bearer
      ? verifySessionTokenForLogout(bearer, deps.authSecret)
      : null
    if (verification?.ok) {
      const revoked = await operations.revokeSession(
        deps.prisma,
        verification.claims.sub,
        verification.claims.sid,
      )
      if (revoked > 0) {
        await operations.clearPresence(deps.prisma, verification.claims.sub)
      }
      return reply.code(204).send()
    }

    const rawRefreshToken = readRefreshCookie(request)
    if (rawRefreshToken) {
      const revoked = await operations.revokeByRefreshToken(deps.prisma, rawRefreshToken)
      if (revoked) {
        await operations.clearPresence(deps.prisma, revoked.userId)
      }
    }
    return reply.code(204).send()
  })
}
