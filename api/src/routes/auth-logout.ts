import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { PrismaClient } from '@prisma/client'

import { verifySessionTokenForLogout } from '../auth/session.js'
import { clearPushSurfacePresenceForUser } from '../services/push-surface-presence.js'
import { revokeUserSession } from '../services/refresh-session-management.js'

type LogoutDeps = {
  authSecret: string
  getAuthorizationToken: (request: FastifyRequest) => string | null
  prisma: PrismaClient
}

type LogoutOperations = {
  clearPresence: typeof clearPushSurfacePresenceForUser
  revokeSession: typeof revokeUserSession
}

const defaultOperations: LogoutOperations = {
  clearPresence: clearPushSurfacePresenceForUser,
  revokeSession: revokeUserSession,
}

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
    }
    return reply.code(204).send()
  })
}
