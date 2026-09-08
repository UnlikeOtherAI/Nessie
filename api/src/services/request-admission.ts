import type { NessieConfig } from '@nessie/config'
import type { FastifyReply, FastifyRequest } from 'fastify'
import type { PrismaClient } from '@prisma/client'
import type {
  AuthorizedActionContext,
  MeResponse,
} from '@nessie/schemas'

import {
  isSessionTokenRevoked,
  verifySessionToken,
  type SessionTokenClaims,
} from '../auth/session.js'
import { sendApiError } from '../lib/api.js'
import {
  buildMeResponse,
  createActorContextFromClaims,
} from './auth.js'
import { hasActiveUserSession } from './refresh-session-management.js'
import {
  authorizeUoaRequest,
  type UoaRequestAuthorization,
} from './uoa-request-authorization.js'

export type AuthenticatedRequestState = {
  actorContext: AuthorizedActionContext
  claims: SessionTokenClaims
  me: MeResponse
}

type RequestAdmissionDependencies = {
  authSecret: string
  config: NessieConfig
  getAuthorizationToken: (request: FastifyRequest) => string | null
  isSessionRevokedById: (sessionId: string) => Promise<boolean>
  prisma: PrismaClient
  authorizeUoaRequest?: (
    organizationId: string,
    identity: SessionTokenClaims['uoaIdentity'],
  ) => Promise<UoaRequestAuthorization>
}

/**
 * Reads a bearer from the normal header, or from a WebSocket upgrade query
 * where browsers cannot set request headers.
 */
export const getAuthorizationToken = (request: FastifyRequest): string | null => {
  const header = request.headers.authorization
  if (header) {
    const [scheme, token] = header.split(' ')
    if (scheme === 'Bearer' && token) return token
  }

  if (request.headers.upgrade?.toLowerCase() === 'websocket') {
    const query = request.query as { token?: unknown } | undefined
    if (query && typeof query.token === 'string' && query.token) return query.token
  }

  return null
}

/**
 * Admits one human API request. The dependency boundary keeps token parsing,
 * revocation, local membership, and UOA's live proof together without making
 * server construction or route tests boot a Fastify application.
 */
export const createRequestAdmission = (deps: RequestAdmissionDependencies) => {
  const authorize = deps.authorizeUoaRequest ?? authorizeUoaRequest

  return async (
    request: FastifyRequest,
    reply: FastifyReply | null,
  ): Promise<AuthenticatedRequestState | null> => {
    const reject = (status: number, code: string, message: string): null => {
      if (reply) sendApiError(reply, status, code, message)
      return null
    }
    const token = deps.getAuthorizationToken(request)
    if (!token) return reject(401, 'AUTH_REQUIRED', 'Missing or invalid authorization header')

    const verification = verifySessionToken(token, deps.authSecret)
    if (!verification.ok) return reject(401, verification.code, verification.message)

    const user = await deps.prisma.user.findUnique({
      where: { id: verification.claims.sub },
    })
    if (!user) return reject(401, 'USER_NOT_FOUND', 'User no longer exists')

    if (isSessionTokenRevoked(verification.claims, user.tokenVersion)) {
      return reject(401, 'TOKEN_REVOKED', 'Session has been revoked')
    }
    if (await deps.isSessionRevokedById(verification.claims.sid)) {
      return reject(401, 'TOKEN_REVOKED', 'Session has been revoked')
    }
    if (!(await hasActiveUserSession(deps.prisma, verification.claims.sub, verification.claims.sid))) {
      return reject(401, 'TOKEN_REVOKED', 'Session has been revoked')
    }

    const membership = await deps.prisma.organizationMember.findUnique({
      where: {
        organizationId_userId: {
          organizationId: verification.claims.org,
          userId: verification.claims.sub,
        },
      },
      select: { role: true, deactivatedAt: true },
    })
    if (membership?.deactivatedAt) {
      return reject(403, 'ACCOUNT_DEACTIVATED', 'Your access to this organisation has been deactivated')
    }
    const organization = await deps.prisma.organization.findUnique({
      where: { id: verification.claims.org },
      select: { externalOrgId: true },
    })
    if (!membership && organization?.externalOrgId) {
      return reject(
        403,
        'ORGANIZATION_MEMBERSHIP_REQUIRED',
        'Your membership of this organisation is no longer held by UnlikeOtherAI',
      )
    }

    const actorContext = createActorContextFromClaims(verification.claims)
    if (membership) actorContext.actor.roles = [membership.role]
    if (organization?.externalOrgId) {
      const authorization = await authorize(organization.externalOrgId, verification.claims.uoaIdentity)
      if (authorization.status === 'unavailable') {
        return reject(503, 'UOA_AUTHORIZATION_UNAVAILABLE', 'UnlikeOtherAI could not verify your access. Please retry.')
      }
      if (authorization.status === 'forbidden') {
        return reject(403, 'UOA_ACCESS_REVOKED', 'Sign in with UnlikeOtherAI to verify your current access.')
      }
      actorContext.actor.roles = [authorization.role]
    }
    request.actorContext = actorContext

    return {
      actorContext,
      claims: verification.claims,
      me: await buildMeResponse(deps.prisma, user, verification.claims, deps.config),
    }
  }
}
