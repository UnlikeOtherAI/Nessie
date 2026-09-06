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
  /**
   * Drop the ended session from THIS replica's revocation cache. Optional so a
   * narrow test harness can register the route without a whole server context;
   * the composition root always supplies it.
   */
  invalidateSessionRevocationCache?: (sessionId: string) => void
  prisma: PrismaClient
  /** Announce the revocation to the other replicas. Optional for the same reason. */
  publishSessionRevocation?: (sessionId: string) => Promise<void>
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
 * Forget one just-revoked session everywhere: this process's cache first (so
 * the very next request here re-reads and rejects), then a broadcast for the
 * other replicas. The broadcast is best-effort — its failure is logged, never
 * surfaced, because the session is already durably revoked and the caches all
 * expire on their own.
 */
const dropRevokedSession = async (
  deps: LogoutDeps,
  request: FastifyRequest,
  sessionId: string,
): Promise<void> => {
  deps.invalidateSessionRevocationCache?.(sessionId)
  try {
    await deps.publishSessionRevocation?.(sessionId)
  } catch (err) {
    request.log.error({ err }, 'session_revocation_broadcast_failed')
  }
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
 *
 * Revocation caching. Every replica memoises the `auth_sessions` lookup for
 * 30 s. `DELETE /api/auth/sessions/:sessionId` has always dropped the sid from
 * the handling replica's cache; this route did not, and leaned on the live
 * refresh-token check that happens to run per request (audit 1.8). It now does
 * both: the local invalidate, so the replica that handled the logout stops
 * honouring the access token at once, and a NOTIFY so every other replica
 * drops it too. The TTL remains the backstop for a replica whose LISTEN was
 * down, so a lost notification costs latency and never correctness.
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
      const sessionId = verification.claims.sid
      const revoked = await operations.revokeSession(
        deps.prisma,
        verification.claims.sub,
        sessionId,
      )
      if (revoked > 0) {
        await dropRevokedSession(deps, request, sessionId)
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
