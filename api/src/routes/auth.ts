import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

import { setRefreshCookie } from '../lib/refresh-cookie.js'
import { issueRefreshToken } from '../services/refresh-token.js'
import { registerAuthCoreRoutes } from './auth-core.js'
import { registerAuthLoginRoute } from './auth-login.js'
import { registerAuthRefreshRoute } from './auth-refresh.js'
import { registerAuthSecurityRoutes } from './auth-security.js'
import { registerAuthUoaWorkspaceRoute } from './auth-uoa-workspace.js'
import type { IssueRefreshCookie } from './auth-shared.js'
import type { RouteDeps } from './types.js'

const createRefreshCookieIssuer = (deps: RouteDeps): IssueRefreshCookie => async (
  request: FastifyRequest,
  reply: FastifyReply,
  params,
) => {
  const { authSecret, config, prisma } = deps
  const { rawToken } = await issueRefreshToken(prisma, {
    userId: params.userId,
    organizationId: params.organizationId,
    sessionId: params.sessionId,
    providerId: params.providerId,
    providerType: params.providerType,
    ...(params.uoaSession
      ? {
          encryptionSecret: authSecret,
          uoaSession: {
            configUrl: params.uoaSession.exchange.configUrl,
            identity: params.uoaSession.identity,
            refreshToken: params.uoaSession.exchange.refreshToken,
            refreshTokenExpiresAt: new Date(
              Date.now()
              + params.uoaSession.exchange.refreshTokenExpiresInSeconds * 1000,
            ),
          },
        }
      : {}),
    ttlSeconds: config.auth.refreshTokenTtlSeconds,
    userAgent: request.headers['user-agent'] ?? null,
    expectedPasswordHash: params.expectedPasswordHash,
  })
  setRefreshCookie(reply, rawToken, config, config.auth.refreshTokenTtlSeconds)
}

export const registerAuthRoutes = (
  app: FastifyInstance,
  deps: RouteDeps,
): void => {
  const issueRefreshCookie = createRefreshCookieIssuer(deps)
  registerAuthCoreRoutes(app, deps, issueRefreshCookie)
  registerAuthLoginRoute(app, deps, issueRefreshCookie)
  registerAuthRefreshRoute(app, deps)
  registerAuthSecurityRoutes(app, deps, issueRefreshCookie)
  registerAuthUoaWorkspaceRoute(app, deps)
}
