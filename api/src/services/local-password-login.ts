import type { FastifyReply, FastifyRequest } from 'fastify'
import { MeResponseSchema } from '@nessie/schemas'

import { verifyPassword } from '../auth/password.js'
import { createApiResponse, sendApiError } from '../lib/api.js'
import type { IssueRefreshCookie } from '../routes/auth-shared.js'
import type { RouteDeps } from '../routes/types.js'
import {
  buildMeResponse,
  createActorContextFromClaims,
} from './auth.js'
import { attemptGlobalAgentsBootstrap } from './global-agents.js'
import { attemptPersonalAssistantAvatar } from './personal-assistant-avatar.js'
import { ensurePersonalAssistantBootstrap } from './personal-assistant.js'
import { RefreshTokenIssuanceError } from './refresh-token.js'
import { loadSessionUserByEmail } from './users.js'

type LocalPasswordCredentials = {
  email?: string
  password?: string
}

/**
 * The local-install password admission lane. UOA-bound people and
 * organisations are refused here so a password can never become a parallel
 * identity path beside UnlikeOtherAI.
 */
export const authenticateLocalPassword = async (
  credentials: LocalPasswordCredentials,
  request: FastifyRequest,
  reply: FastifyReply,
  deps: RouteDeps,
  issueRefreshCookie: IssueRefreshCookie,
) => {
  if (deps.config.mode !== 'local') {
    sendApiError(
      reply,
      403,
      'PASSWORD_AUTH_DISABLED',
      'Password sign-in is disabled on this deployment. Sign in with your identity provider.',
    )
    return reply
  }
  if (!credentials.email || !credentials.password) {
    sendApiError(reply, 400, 'PASSWORD_REQUIRED', 'Password is required', 'password')
    return reply
  }
  const user = await loadSessionUserByEmail(deps.prisma, credentials.email)
  if (user?.uoaSub) {
    sendApiError(reply, 403, 'PASSWORD_AUTH_DISABLED', 'Sign in with UnlikeOtherAI to access this account.')
    return reply
  }
  if (!user?.passwordHash || !(await verifyPassword(credentials.password, user.passwordHash))) {
    sendApiError(reply, 401, 'INVALID_CREDENTIALS', 'Invalid email or password')
    return reply
  }
  const primaryOrganizationMember = user.organizationMembers[0]
  if (!primaryOrganizationMember) {
    sendApiError(reply, 401, 'INVALID_CREDENTIALS', 'Invalid email or password')
    return reply
  }
  const localOrganization = await deps.prisma.organization.findUnique({
    where: { id: primaryOrganizationMember.organizationId },
    select: { externalOrgId: true },
  })
  if (localOrganization?.externalOrgId) {
    sendApiError(reply, 403, 'PASSWORD_AUTH_DISABLED', 'Sign in with UnlikeOtherAI to access this organisation.')
    return reply
  }
  const session = await deps.buildLocalSession(
    user.id,
    [primaryOrganizationMember.role],
    undefined,
    { userAgent: request.headers['user-agent'] ?? null },
  )
  const actorContext = createActorContextFromClaims(session.claims)
  await ensurePersonalAssistantBootstrap(deps.prisma, {
    organizationId: actorContext.tenant.organizationId,
    teamId: actorContext.tenant.teamId!,
    userId: user.id,
  })
  await attemptGlobalAgentsBootstrap(
    deps.prisma,
    {
      organizationId: actorContext.tenant.organizationId,
      teamId: actorContext.tenant.teamId!,
      userId: user.id,
    },
    (error) => request.log.error({ err: error }, 'global_agent_bootstrap_failed'),
  )
  await attemptPersonalAssistantAvatar({
    actorContext,
    config: deps.config.model,
    fileService: deps.fileService,
    ledgerIdentity: deps.ledgerIdentity,
    modelClient: deps.sharedModelClient,
    organizationId: actorContext.tenant.organizationId,
    prisma: deps.prisma,
  })
  try {
    await issueRefreshCookie(request, reply, {
      userId: user.id,
      organizationId: session.claims.org,
      sessionId: session.sessionId,
      providerId: session.claims.providerId,
      providerType: session.claims.providerType,
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
      await buildMeResponse(deps.prisma, user, session.claims, deps.config),
    ),
  })
}
