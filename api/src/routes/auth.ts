import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { Prisma } from '@prisma/client'

import { MeResponseSchema, UpdateMyAvatarRequestSchema, UpdatePreferencesSchema } from '@nessie/schemas'
import { isBootstrapTokenExpired } from '../auth/bootstrap.js'
import { hashPassword, verifyPassword } from '../auth/password.js'
import { verifySessionToken, type SessionTokenClaims } from '../auth/session.js'
import {
  AuthProviderAuthorizeQuerySchema,
  AuthProviderDescriptorSchema,
  BootstrapModeResponseSchema,
  BootstrapRequestSchema,
  ChangePasswordRequestSchema,
  LoginRequestSchema,
  SsoConfigQuerySchema,
} from '../contracts.js'
import { seedBootstrapRecords } from '../db/seed.js'
import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import {
  LOCAL_AUTH_PROVIDER_ID, buildMeResponse, listAuthProviders, resolveConfiguredAuthProvider,
} from '../services/auth.js'
import { canAccessAttachment } from '../services/attachments.js'
import { buildExternalAuthAuthorizeUrl, exchangeExternalAuthCode } from '../services/external-auth.js'
import { resolveExternalWorkspaceSelection } from '../services/identity-display.js'
import { syncUoaProductAccountLinks } from '../services/integrations.js'
import { seedDefaultPolicies } from '../services/policy.js'
import { buildConfigJwt, buildPublicJwks, isUoaConfigured, loadUoaSettings } from '../services/uoa-auth.js'
import { loadSessionUserByEmail } from '../services/users.js'
import { resolveUoaWorkspaceContext } from '../services/workspace-context.js'
import { confirmUoaDirectServiceAccess } from '../services/uoa-billing-client.js'
import { clearRefreshCookie, readRefreshCookie, setRefreshCookie } from '../lib/refresh-cookie.js'
import {
  consumeRefreshToken,
  issueRefreshToken,
  listUserSessions,
  revokeRefreshTokenByRaw,
  revokeUserSession,
} from '../services/refresh-token.js'
import type { RouteDeps } from './types.js'

const CREATED_AT_ASC = { createdAt: 'asc' } as const

// Brand icon shared with the UOA hosted login page. Bundled in the image at
// admin/public/icon-1024.png (cwd is the workspace root). Read once and cached.
let cachedBrandIcon: Buffer | null = null
const readBrandIcon = (): Buffer | null => {
  if (cachedBrandIcon) {
    return cachedBrandIcon
  }
  const iconPath = resolve(process.cwd(), 'admin/public/icon-1024.png')
  if (!existsSync(iconPath)) {
    return null
  }
  cachedBrandIcon = readFileSync(iconPath)
  return cachedBrandIcon
}

export const registerAuthRoutes = (app: FastifyInstance, deps: RouteDeps): void => {
  const { config, prisma, authSecret, DEFAULT_LOCAL_PROVIDER_TYPE } = deps
  const { requireActorContext, resolveBootstrapState, clearBootstrapState, getAuthorizationToken } = deps
  const { authenticateRequest, buildLocalSession, buildSessionForUser } = deps

  // Mint a rotating refresh token for a freshly issued session and drop it in
  // the httpOnly cookie. Called from every access-token-minting route so a
  // login of any kind can be silently renewed for the refresh TTL window.
  const issueRefreshCookie = async (
    request: FastifyRequest,
    reply: FastifyReply,
    params: { userId: string; sessionId: string; providerId: string; providerType: string },
  ): Promise<void> => {
    const { rawToken } = await issueRefreshToken(prisma, {
      userId: params.userId,
      sessionId: params.sessionId,
      providerId: params.providerId,
      providerType: params.providerType,
      ttlSeconds: config.auth.refreshTokenTtlSeconds,
      userAgent: request.headers['user-agent'] ?? null,
    })
    setRefreshCookie(reply, rawToken, config, config.auth.refreshTokenTtlSeconds)
  }

  app.get('/api/auth/providers', { config: { public: true } }, async () =>
    createApiResponse(AuthProviderDescriptorSchema.array().parse(listAuthProviders(config))),
  )

  // UOA (UnlikeOtherAuthenticator) integration endpoints. The signed config JWT
  // describes this deployment to UOA; the JWKS lets UOA verify it. Both are only
  // served when UOA is configured via env.
  app.get('/api/auth/sso/config', { config: { public: true } }, async (request, reply) => {
    const query = parseInput(SsoConfigQuerySchema, request.query, reply)
    if (!query) {
      return reply
    }
    if (!isUoaConfigured()) {
      sendApiError(reply, 404, 'SSO_NOT_CONFIGURED', 'UOA SSO is not configured')
      return reply
    }
    return reply
      .header('content-type', 'application/jwt')
      .send(buildConfigJwt(loadUoaSettings(), query.theme))
  })

  app.get('/.well-known/jwks.json', { config: { public: true } }, async (_request, reply) => {
    if (!isUoaConfigured()) {
      sendApiError(reply, 404, 'SSO_NOT_CONFIGURED', 'UOA SSO is not configured')
      return reply
    }
    return reply.send(buildPublicJwks(loadUoaSettings()))
  })

  // Brand logo for the UOA hosted login page. UOA requires the config `logo.url`
  // to share the config domain's origin (api.nessie…), so the API serves the
  // same icon the admin uses. Cached after first read.
  app.get('/icon.png', { config: { public: true } }, async (_request, reply) => {
    const icon = readBrandIcon()
    if (!icon) {
      sendApiError(reply, 404, 'NOT_FOUND', 'Brand icon not found')
      return reply
    }
    return reply
      .header('content-type', 'image/png')
      .header('cache-control', 'public, max-age=86400')
      .send(icon)
  })

  app.get('/api/auth/providers/:providerId/authorize', { config: { public: true } }, async (request, reply) => {
    const query = parseInput(AuthProviderAuthorizeQuerySchema, request.query, reply)
    if (!query) {
      return reply
    }

    const providerId = (request.params as { providerId?: string } | undefined)?.providerId
    if (!providerId) {
      sendApiError(reply, 400, 'PROVIDER_REQUIRED', 'Provider id is required', 'providerId')
      return reply
    }

    const provider = resolveConfiguredAuthProvider(config, providerId)
    if (!provider) {
      sendApiError(reply, 404, 'PROVIDER_NOT_FOUND', 'Auth provider was not found', 'providerId')
      return reply
    }

    try {
      const authorizeUrl = await buildExternalAuthAuthorizeUrl(provider, query)
      return createApiResponse({ authorizeUrl })
    } catch (error) {
      sendApiError(
        reply,
        400,
        'PROVIDER_NOT_SUPPORTED',
        error instanceof Error ? error.message : 'Provider is not supported',
        'providerId',
      )
      return reply
    }
  })

  app.get('/api/auth/me', { config: { public: true } }, async (request, reply) => {
    const token = getAuthorizationToken(request)
    if (!token) {
      const state = await resolveBootstrapState()
      if (state) {
        return createApiResponse(BootstrapModeResponseSchema.parse({ bootstrapMode: true, bootstrapUrl: '/bootstrap' }))
      }

      sendApiError(reply, 401, 'AUTH_REQUIRED', 'Authentication required')
      return reply
    }

    const authenticatedState = await authenticateRequest(request, reply)
    if (!authenticatedState) {
      return reply
    }

    return createApiResponse(MeResponseSchema.parse(authenticatedState.me))
  })

  app.patch('/api/auth/me/preferences', async (request, reply) => {
    const authenticatedState = await authenticateRequest(request, reply)
    if (!authenticatedState) {
      return reply
    }

    const body = parseInput(UpdatePreferencesSchema, request.body, reply)
    if (!body) {
      return reply
    }

    // PATCH = partial merge: each settings surface (appearance, notifications,
    // starred) owns a disjoint slice and sends only its own keys. Provided keys
    // overwrite, absent keys are preserved, and an explicit `null` clears a key.
    const existing = (authenticatedState.me.user.preferences ?? {}) as Record<string, unknown>
    const nextPreferences: Record<string, unknown> = { ...existing }
    for (const [key, value] of Object.entries(body)) {
      if (value === undefined) {
        continue
      }
      if (value === null) {
        delete nextPreferences[key]
      } else {
        nextPreferences[key] = value
      }
    }

    const updatedUser = await prisma.user.update({
      where: { id: authenticatedState.claims.sub },
      data: { preferences: nextPreferences as Prisma.InputJsonValue },
    })

    const me = await buildMeResponse(prisma, updatedUser, authenticatedState.claims, config)
    return createApiResponse(MeResponseSchema.parse(me))
  })

  // Set or clear the signed-in user's custom avatar. The id must reference an
  // image Attachment in the actor's organization (uploaded via POST /api/uploads);
  // `null` clears it, reverting to the provider picture / Gravatar.
  app.patch('/api/auth/me/avatar', async (request, reply) => {
    const authenticatedState = await authenticateRequest(request, reply)
    if (!authenticatedState) {
      return reply
    }

    const body = parseInput(UpdateMyAvatarRequestSchema, request.body, reply)
    if (!body) {
      return reply
    }

    if (body.avatarAttachmentId) {
      const attachment = await prisma.attachment.findUnique({
        where: { id: body.avatarAttachmentId },
      })
      const organizationId = authenticatedState.actorContext.tenant.organizationId
      if (
        !attachment ||
        !(await canAccessAttachment(prisma, attachment, {
          organizationId,
          userId: authenticatedState.actorContext.actor.actorId,
        }))
      ) {
        sendApiError(reply, 404, 'ATTACHMENT_NOT_FOUND', 'Attachment not found')
        return reply
      }
      if (attachment.kind !== 'image') {
        sendApiError(reply, 400, 'INVALID_AVATAR', 'Avatar must be an image')
        return reply
      }
    }

    const updatedUser = await prisma.user.update({
      where: { id: authenticatedState.claims.sub },
      data: { avatarAttachmentId: body.avatarAttachmentId },
    })

    const me = await buildMeResponse(prisma, updatedUser, authenticatedState.claims, config)
    return createApiResponse(MeResponseSchema.parse(me))
  })

  app.post('/api/auth/bootstrap', { config: { public: true } }, async (request, reply) => {
    const body = parseInput(BootstrapRequestSchema, request.body, reply)
    if (!body) {
      return reply
    }

    const state = await resolveBootstrapState()
    if (!state) {
      sendApiError(reply, 409, 'BOOTSTRAP_DISABLED', 'Bootstrap is no longer available')
      return reply
    }

    if (state.token !== body.bootstrapToken) {
      sendApiError(reply, 401, 'TOKEN_INVALID', 'Invalid bootstrap token')
      return reply
    }

    if (isBootstrapTokenExpired(state)) {
      // Do NOT null the state here — that would re-arm minting on the next
      // resolveBootstrapState() call. Leaving the expired state in place
      // forces an explicit process restart to recover.
      sendApiError(reply, 401, 'TOKEN_EXPIRED', 'Bootstrap token expired')
      return reply
    }

    if ((await prisma.user.count()) > 0) {
      clearBootstrapState()
      sendApiError(reply, 409, 'BOOTSTRAP_DISABLED', 'Bootstrap is no longer available')
      return reply
    }

    const passwordHash = await hashPassword(body.password)
    const result = await seedBootstrapRecords(prisma, {
      email: body.email,
      displayName: body.displayName,
      passwordHash,
    })
    await seedDefaultPolicies(prisma, result.organizationId, result.user.id)
    clearBootstrapState()

    const session = await buildLocalSession(result.user.id, ['owner'])
    const verification = verifySessionToken(session.token, authSecret)
    if (!verification.ok) {
      sendApiError(reply, 500, 'TOKEN_INVALID', 'Failed to issue bootstrap session')
      return reply
    }

    await issueRefreshCookie(request, reply, {
      userId: result.user.id,
      sessionId: session.sessionId,
      providerId: verification.claims.providerId,
      providerType: verification.claims.providerType,
    })

    return reply.code(201).send(
      createApiResponse({
        token: session.token,
        me: MeResponseSchema.parse(await buildMeResponse(prisma,result.user, verification.claims, config)),
      }),
    )
  })

  app.post('/api/auth/session', { config: { public: true } }, async (request, reply) => {
    const body = parseInput(LoginRequestSchema, request.body, reply)
    if (!body) {
      return reply
    }

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
        const identity = await exchangeExternalAuthCode(provider, {
          code: body.code,
          codeVerifier: body.codeVerifier,
          redirectUri: body.redirectUri,
          theme: body.theme,
        })

        // Slack-style workspace routing: resolve (auto-provisioning as needed)
        // the shared org + the project/team for the UOA workspace the user
        // selected (`identity.workspace.active*`), and the memberships, instead
        // of always landing every SSO user in the first org's default team.
        // Non-UOA providers and single-workspace users carry no workspace and
        // fall back to their existing/default team unchanged.
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

        // Self-heal accounts whose display name is just their email — the old
        // SSO fallback before names were humanized. Only touches the broken case
        // (displayName === email), so a user-chosen name is never clobbered.
        if (sessionUser.displayName === sessionUser.email && identity.displayName !== sessionUser.displayName) {
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

        if (provider.type === 'uoa') {
          await syncUoaProductAccountLinks(prisma, {
            email: identity.email,
            externalSubject: identity.externalSubject,
            organizationId: context.organizationId,
            userId: context.userId,
            workspace: identity.workspace,
          })
          const externalWorkspace = resolveExternalWorkspaceSelection(
            identity.workspace,
          )
          if (
            !identity.externalSubject
            || !externalWorkspace.organizationId
            || !externalWorkspace.teamId
          ) {
            throw new Error(
              'UnlikeOtherAI did not return an exact user, organization, and team.',
            )
          }
          await confirmUoaDirectServiceAccess({
            organizationId: externalWorkspace.organizationId,
            teamId: externalWorkspace.teamId,
            userId: identity.externalSubject,
          })
        }

        const session = buildSessionForUser({
          organizationId: context.organizationId,
          projectId: context.projectId,
          providerId: provider.providerId,
          providerType: provider.type,
          roles: [context.orgRole],
          teamId: context.teamId,
          userId: context.userId,
        })
        const verification = verifySessionToken(session.token, authSecret)
        if (!verification.ok) {
          sendApiError(reply, 500, 'TOKEN_INVALID', 'Failed to issue external auth session')
          return reply
        }

        await issueRefreshCookie(request, reply, {
          userId: sessionUser.id,
          sessionId: session.sessionId,
          providerId: verification.claims.providerId,
          providerType: verification.claims.providerType,
        })

        return createApiResponse({
          token: session.token,
          me: MeResponseSchema.parse(await buildMeResponse(prisma, sessionUser, verification.claims, config)),
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

    const sessionRoles = [primaryOrganizationMember.role]
    const session = await buildLocalSession(user.id, sessionRoles)
    const verification = verifySessionToken(session.token, authSecret)
    if (!verification.ok) {
      sendApiError(reply, 500, 'TOKEN_INVALID', 'Failed to issue session')
      return reply
    }

    await issueRefreshCookie(request, reply, {
      userId: user.id,
      sessionId: session.sessionId,
      providerId: verification.claims.providerId,
      providerType: verification.claims.providerType,
    })

    return createApiResponse({
      token: session.token,
      me: MeResponseSchema.parse(await buildMeResponse(prisma, user, verification.claims, config)),
    })
  })

  app.get('/api/auth/dev-login', { config: { public: true } }, async (request, reply) => {
    if (config.mode !== 'local') {
      sendApiError(reply, 403, 'FORBIDDEN', 'Dev login is only available in local mode')
      return reply
    }

    const isLoopback = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.ip)
    if (!isLoopback) {
      sendApiError(reply, 403, 'FORBIDDEN', 'Dev login is only available from localhost')
      return reply
    }

    const user = await prisma.user.findFirst({
      include: { organizationMembers: true, projectMembers: true, teamMembers: true },
      orderBy: CREATED_AT_ASC,
    })

    if (!user) {
      sendApiError(reply, 404, 'NO_USERS', 'No users exist yet')
      return reply
    }

    const organizationMember = user.organizationMembers[0]
    if (!organizationMember) {
      sendApiError(reply, 500, 'NO_MEMBERSHIP', 'User has no organization membership')
      return reply
    }

    const sessionRoles = [organizationMember.role]
    const session = await buildLocalSession(user.id, sessionRoles)
    const verification = verifySessionToken(session.token, authSecret)
    if (!verification.ok) {
      sendApiError(reply, 500, 'TOKEN_INVALID', 'Failed to issue dev session')
      return reply
    }

    await issueRefreshCookie(request, reply, {
      userId: user.id,
      sessionId: session.sessionId,
      providerId: verification.claims.providerId,
      providerType: verification.claims.providerType,
    })

    return createApiResponse({
      token: session.token,
      me: MeResponseSchema.parse(await buildMeResponse(prisma, user, verification.claims, config)),
    })
  })

  // Renew the short-lived access token from the rotating refresh cookie. Public
  // because the expired access token is gone by definition — identity comes from
  // the httpOnly cookie. Rotates the refresh token and re-resolves the user's
  // current org/role membership on every call.
  app.post('/api/auth/refresh', { config: { public: true } }, async (request, reply) => {
    const rawToken = readRefreshCookie(request)
    if (!rawToken) {
      sendApiError(reply, 401, 'NO_REFRESH_TOKEN', 'No refresh token')
      return reply
    }

    const consumed = await consumeRefreshToken(prisma, {
      authSecret,
      rawToken,
      ttlSeconds: config.auth.refreshTokenTtlSeconds,
      userAgent: request.headers['user-agent'] ?? null,
    })
    if (!consumed.ok) {
      clearRefreshCookie(reply, config)
      sendApiError(reply, 401, 'REFRESH_INVALID', 'Refresh token is invalid or expired')
      return reply
    }

    const user = await prisma.user.findUnique({ where: { id: consumed.userId } })
    if (!user) {
      clearRefreshCookie(reply, config)
      sendApiError(reply, 401, 'USER_NOT_FOUND', 'User no longer exists')
      return reply
    }

    const session = await buildLocalSession(
      consumed.userId,
      [],
      {
        providerId: consumed.providerId,
        providerType: consumed.providerType as SessionTokenClaims['providerType'],
      },
      // Preserve the login's session id across the rotation chain so the
      // access token's sid stays stable (accurate session list + current-device
      // flag, coherent session-scoped state).
      consumed.sessionId,
    )
    const verification = verifySessionToken(session.token, authSecret)
    if (!verification.ok) {
      sendApiError(reply, 500, 'TOKEN_INVALID', 'Failed to issue session')
      return reply
    }

    const remainingTtlSeconds = Math.max(
      1,
      Math.ceil((consumed.expiresAt.getTime() - Date.now()) / 1000),
    )
    setRefreshCookie(reply, consumed.rawToken, config, remainingTtlSeconds)

    return createApiResponse({
      token: session.token,
      me: MeResponseSchema.parse(await buildMeResponse(prisma, user, verification.claims, config)),
    })
  })

  // Public so a session can be revoked even when the access token has already
  // expired — identity for logout comes from the httpOnly refresh cookie, which
  // is revoked server-side and cleared here so the session can't be resurrected.
  app.delete('/api/auth/session', { config: { public: true } }, async (request, reply) => {
    const rawToken = readRefreshCookie(request)
    if (rawToken) {
      await revokeRefreshTokenByRaw(prisma, rawToken)
    }
    clearRefreshCookie(reply, config)
    reply.code(204)
    return null
  })

  // The `sid` of the access token on this request, used to flag the caller's
  // current session in the list and to clear the cookie when they revoke it.
  const currentSessionId = (request: FastifyRequest): string | null => {
    const token = getAuthorizationToken(request)
    if (!token) return null
    const verification = verifySessionToken(token, authSecret)
    return verification.ok ? verification.claims.sid : null
  }

  app.get('/api/auth/sessions', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply

    const sessions = await listUserSessions(prisma, actorContext.actor.actorId)
    const currentSid = currentSessionId(request)
    return createApiResponse(
      sessions.map((session) => ({
        sessionId: session.sessionId,
        userAgent: session.userAgent,
        createdAt: session.createdAt.toISOString(),
        lastUsedAt: session.lastUsedAt.toISOString(),
        expiresAt: session.expiresAt.toISOString(),
        current: session.sessionId === currentSid,
      })),
    )
  })

  app.delete('/api/auth/sessions/:sessionId', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply

    const { sessionId } = request.params as { sessionId: string }
    const revoked = await revokeUserSession(prisma, actorContext.actor.actorId, sessionId)
    if (revoked === 0) {
      sendApiError(reply, 404, 'SESSION_NOT_FOUND', 'No such active session')
      return reply
    }

    // Revoking your own current session is a logout — clear the cookie too so it
    // can't be resurrected by the still-valid refresh token.
    if (currentSessionId(request) === sessionId) {
      clearRefreshCookie(reply, config)
    }
    return createApiResponse({ revoked })
  })

  app.post('/api/auth/password', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply

    const body = parseInput(ChangePasswordRequestSchema, request.body, reply)
    if (!body) return reply

    const userId = actorContext.actor.actorId
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { passwordHash: true },
    })
    // Only local-password accounts can change a password here; SSO accounts have
    // no password and manage credentials at their identity provider.
    if (!user?.passwordHash) {
      sendApiError(reply, 400, 'PASSWORD_NOT_SUPPORTED', 'This account does not use a password')
      return reply
    }
    if (!(await verifyPassword(body.currentPassword, user.passwordHash))) {
      sendApiError(reply, 400, 'INVALID_PASSWORD', 'Current password is incorrect')
      return reply
    }

    await prisma.user.update({
      where: { id: userId },
      data: { passwordHash: await hashPassword(body.newPassword) },
    })

    // Changing a password should evict other devices (the usual reason to change
    // it is suspected compromise). Revoke every refresh token except the caller's
    // current session, so a stolen refresh cookie can no longer renew access.
    const currentSid = currentSessionId(request)
    await prisma.refreshToken.updateMany({
      where: {
        userId,
        revokedAt: null,
        ...(currentSid ? { sessionId: { not: currentSid } } : {}),
      },
      data: { revokedAt: new Date() },
    })
    return createApiResponse({ ok: true })
  })

  app.post('/api/auth/switch-context', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply

    const body = request.body as { organizationId?: string; projectId?: string; teamId?: string } | undefined

    if (!body?.organizationId || !body?.projectId || !body?.teamId) {
      sendApiError(reply, 400, 'INVALID_INPUT', 'organizationId, projectId, and teamId are required')
      return reply
    }

    const { organizationId, projectId, teamId } = body
    const userId = actorContext.actor.actorId

    // Verify membership
    const orgMember = await prisma.organizationMember.findUnique({
      where: { organizationId_userId: { organizationId, userId } },
    })
    if (!orgMember) {
      sendApiError(reply, 403, 'NOT_A_MEMBER', 'Not a member of this organization')
      return reply
    }
    // Don't mint a session for an org the caller is deactivated in (the row
    // survives deactivation), mirroring the authenticateRequest check.
    if (orgMember.deactivatedAt) {
      sendApiError(reply, 403, 'ACCOUNT_DEACTIVATED', 'Your access to this organisation has been deactivated')
      return reply
    }

    const project = await prisma.project.findUnique({ where: { id: projectId } })
    if (!project || project.organizationId !== organizationId) {
      sendApiError(reply, 403, 'NOT_A_MEMBER', 'Not a member of this project/team')
      return reply
    }

    const projectMember = await prisma.projectMember.findUnique({
      where: { projectId_userId: { projectId, userId } },
    })
    if (!projectMember) {
      sendApiError(reply, 403, 'NOT_A_MEMBER', 'Not a member of this project/team')
      return reply
    }

    const team = await prisma.team.findUnique({ where: { id: teamId } })
    if (!team || team.projectId !== projectId) {
      sendApiError(reply, 403, 'NOT_A_MEMBER', 'Not a member of this project/team')
      return reply
    }

    const teamMember = await prisma.teamMember.findUnique({
      where: { teamId_userId: { teamId, userId } },
    })
    if (!teamMember) {
      sendApiError(reply, 403, 'NOT_A_MEMBER', 'Not a member of this project/team')
      return reply
    }

    const session = buildSessionForUser({
      organizationId,
      projectId,
      providerId: LOCAL_AUTH_PROVIDER_ID,
      providerType: DEFAULT_LOCAL_PROVIDER_TYPE as SessionTokenClaims['providerType'],
      roles: [orgMember.role],
      teamId,
      userId,
    })

    const verification = verifySessionToken(session.token, authSecret)
    if (!verification.ok) {
      sendApiError(reply, 500, 'TOKEN_INVALID', 'Failed to issue new session')
      return reply
    }

    const user = await prisma.user.findUnique({ where: { id: userId } })
    if (!user) {
      sendApiError(reply, 500, 'USER_NOT_FOUND', 'User not found')
      return reply
    }

    await issueRefreshCookie(request, reply, {
      userId,
      sessionId: session.sessionId,
      providerId: verification.claims.providerId,
      providerType: verification.claims.providerType,
    })

    return createApiResponse({
      token: session.token,
      me: MeResponseSchema.parse(await buildMeResponse(prisma, user, verification.claims, config)),
    })
  })
}
