import type { FastifyInstance } from 'fastify'
import { MeResponseSchema, type UoaSessionIdentity } from '@nessie/schemas'

import { verifyPassword } from '../auth/password.js'
import { verifySessionToken } from '../auth/session.js'
import { LoginRequestSchema } from '../contracts.js'
import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import {
  buildMeResponse,
  LOCAL_AUTH_PROVIDER_ID,
  resolveConfiguredAuthProvider,
} from '../services/auth.js'
import { exchangeExternalAuthCode } from '../services/external-auth.js'
import { resolveExternalWorkspaceSelection } from '../services/identity-display.js'
import { syncUoaProductAccountLinks } from '../services/integrations.js'
import { RefreshTokenIssuanceError } from '../services/refresh-token.js'
import { confirmUoaDirectServiceAccess } from '../services/uoa-billing-client.js'
import { loadSessionUserByEmail } from '../services/users.js'
import { resolveUoaWorkspaceContext } from '../services/workspace-context.js'
import type { IssueRefreshCookie } from './auth-shared.js'
import type { RouteDeps } from './types.js'

export const registerAuthLoginRoute = (
  app: FastifyInstance,
  deps: RouteDeps,
  issueRefreshCookie: IssueRefreshCookie,
): void => {
  const { authSecret, config, prisma, buildLocalSession, buildSessionForUser } = deps

  app.post('/api/auth/session', { config: { public: true } }, async (request, reply) => {
    const body = parseInput(LoginRequestSchema, request.body, reply)
    if (!body) return reply

    if (body.providerId && body.providerId !== LOCAL_AUTH_PROVIDER_ID) {
      if (!body.code || !body.codeVerifier || !body.redirectUri) {
        sendApiError(
          reply,
          400,
          'EXTERNAL_AUTH_INCOMPLETE',
          'providerId, code, codeVerifier, and redirectUri are required',
        )
        return reply
      }
      const provider = resolveConfiguredAuthProvider(config, body.providerId)
      if (!provider) {
        sendApiError(reply, 404, 'PROVIDER_NOT_FOUND', 'Auth provider was not found', 'providerId')
        return reply
      }

      try {
        const exchange = await exchangeExternalAuthCode(provider, {
          code: body.code,
          codeVerifier: body.codeVerifier,
          redirectUri: body.redirectUri,
          theme: body.theme,
        })
        const { identity } = exchange
        const uoaSession = provider.type === 'uoa' ? exchange.uoaSession : undefined
        if (provider.type === 'uoa' && !uoaSession) {
          throw new Error('UnlikeOtherAI did not return a renewable session proof.')
        }
        const verifiedUoaWorkspace = uoaSession
          ? resolveExternalWorkspaceSelection(uoaSession.identity.workspace)
          : undefined
        if (
          uoaSession
          && (!verifiedUoaWorkspace?.organizationId || !verifiedUoaWorkspace.teamId)
        ) {
          throw new Error(
            'UnlikeOtherAI did not return an exact user, organization, and team.',
          )
        }
        if (uoaSession && verifiedUoaWorkspace?.organizationId && verifiedUoaWorkspace.teamId) {
          await confirmUoaDirectServiceAccess({
            organizationId: verifiedUoaWorkspace.organizationId,
            teamId: verifiedUoaWorkspace.teamId,
            tokenVersion: uoaSession.identity.uoaTokenVersion,
            userId: uoaSession.identity.externalSubject,
          })
        }

        const context = await resolveUoaWorkspaceContext(prisma, {
          avatarUrl: identity.avatarUrl,
          displayName: identity.displayName,
          email: identity.email,
          workspace: identity.workspace,
        })
        if (!context) {
          sendApiError(reply, 500, 'NO_DEFAULT_ORG', 'No organization configured for SSO provisioning')
          return reply
        }
        let sessionUser = await loadSessionUserByEmail(prisma, identity.email)
        if (!sessionUser) {
          sendApiError(reply, 500, 'USER_NOT_FOUND', 'Failed to load authenticated user')
          return reply
        }
        if (
          sessionUser.displayName === sessionUser.email
          && identity.displayName !== sessionUser.displayName
        ) {
          await prisma.user.update({
            where: { id: sessionUser.id },
            data: { displayName: identity.displayName },
          })
          sessionUser = await loadSessionUserByEmail(prisma, identity.email)
          if (!sessionUser) {
            sendApiError(reply, 500, 'USER_NOT_FOUND', 'Failed to load authenticated user')
            return reply
          }
        }

        let uoaSessionIdentity: UoaSessionIdentity | undefined
        if (uoaSession && verifiedUoaWorkspace?.organizationId && verifiedUoaWorkspace.teamId) {
          const uoaIdentity = uoaSession.identity
          await syncUoaProductAccountLinks(prisma, {
            email: identity.email,
            externalSubject: uoaIdentity.externalSubject,
            organizationId: context.organizationId,
            uoaTokenVersion: uoaIdentity.uoaTokenVersion,
            userId: context.userId,
            workspace: uoaIdentity.workspace,
          })
          uoaSessionIdentity = {
            organizationId: verifiedUoaWorkspace.organizationId,
            subject: uoaIdentity.externalSubject,
            teamId: verifiedUoaWorkspace.teamId,
            tokenVersion: uoaIdentity.uoaTokenVersion,
          }
        }

        const session = buildSessionForUser({
          organizationId: context.organizationId,
          projectId: context.projectId,
          providerId: provider.providerId,
          providerType: provider.type,
          roles: [context.orgRole],
          teamId: context.teamId,
          uoaIdentity: uoaSessionIdentity,
          userId: context.userId,
        })
        const verification = verifySessionToken(session.token, authSecret)
        if (!verification.ok) {
          sendApiError(reply, 500, 'TOKEN_INVALID', 'Failed to issue external auth session')
          return reply
        }
        await issueRefreshCookie(request, reply, {
          userId: sessionUser.id,
          organizationId: verification.claims.org,
          sessionId: session.sessionId,
          providerId: verification.claims.providerId,
          providerType: verification.claims.providerType,
          ...(uoaSession && verification.claims.uoaIdentity
            ? {
                uoaSession: {
                  exchange: uoaSession,
                  identity: verification.claims.uoaIdentity,
                },
              }
            : {}),
        })
        return createApiResponse({
          token: session.token,
          me: MeResponseSchema.parse(
            await buildMeResponse(prisma, sessionUser, verification.claims, config),
          ),
        })
      } catch (error) {
        sendApiError(
          reply,
          401,
          'EXTERNAL_AUTH_FAILED',
          error instanceof Error ? error.message : 'External authentication failed',
        )
        return reply
      }
    }

    if (!body.email || !body.password) {
      sendApiError(reply, 400, 'PASSWORD_REQUIRED', 'Password is required', 'password')
      return reply
    }
    const user = await loadSessionUserByEmail(prisma, body.email)
    if (!user?.passwordHash || !(await verifyPassword(body.password, user.passwordHash))) {
      sendApiError(reply, 401, 'INVALID_CREDENTIALS', 'Invalid email or password')
      return reply
    }
    const primaryOrganizationMember = user.organizationMembers[0]
    if (!primaryOrganizationMember) {
      sendApiError(reply, 401, 'INVALID_CREDENTIALS', 'Invalid email or password')
      return reply
    }
    const session = await buildLocalSession(user.id, [primaryOrganizationMember.role])
    const verification = verifySessionToken(session.token, authSecret)
    if (!verification.ok) {
      sendApiError(reply, 500, 'TOKEN_INVALID', 'Failed to issue session')
      return reply
    }
    try {
      await issueRefreshCookie(request, reply, {
        userId: user.id,
        organizationId: verification.claims.org,
        sessionId: session.sessionId,
        providerId: verification.claims.providerId,
        providerType: verification.claims.providerType,
        expectedPasswordHash: user.passwordHash,
      })
    } catch (error) {
      if (error instanceof RefreshTokenIssuanceError) {
        sendApiError(reply, 401, 'INVALID_CREDENTIALS', 'Invalid email or password')
        return reply
      }
      throw error
    }
    return createApiResponse({
      token: session.token,
      me: MeResponseSchema.parse(
        await buildMeResponse(prisma, user, verification.claims, config),
      ),
    })
  })
}
