import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import type { FastifyInstance } from 'fastify'
import { Prisma } from '@prisma/client'
import {
  MeResponseSchema,
  UpdateMyAvatarRequestSchema,
  UpdatePreferencesSchema,
} from '@nessie/schemas'

import { isBootstrapTokenExpired } from '../auth/bootstrap.js'
import { hashPassword } from '../auth/password.js'
import { verifySessionToken } from '../auth/session.js'
import {
  AuthProviderAuthorizeQuerySchema,
  AuthProviderDescriptorSchema,
  BootstrapModeResponseSchema,
  BootstrapRequestSchema,
  SsoConfigQuerySchema,
} from '../contracts.js'
import {
  BootstrapAlreadyInitializedError,
  seedBootstrapRecords,
} from '../db/seed.js'
import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import {
  buildMeResponse,
  createActorContextFromClaims,
  listAuthProviders,
  resolveConfiguredAuthProvider,
} from '../services/auth.js'
import { canAccessAttachment } from '../services/attachments.js'
import { buildExternalAuthAuthorizeUrl } from '../services/external-auth.js'
import { attemptPersonalAssistantAvatar } from '../services/personal-assistant-avatar.js'
import { ensurePersonalAssistantBootstrap } from '../services/personal-assistant.js'
import { attemptGlobalAgentsBootstrap } from '../services/global-agents.js'
import {
  buildConfigJwt,
  buildPublicJwks,
  isUoaConfigured,
  loadUoaSettings,
} from '../services/uoa-auth.js'
import { guardAuthRequest, RATE_LIMIT_BUCKETS } from './auth-rate-limit.js'
import { registerAuthLogoutRoute } from './auth-logout.js'
import type { IssueRefreshCookie } from './auth-shared.js'
import type { RouteDeps } from './types.js'

const CREATED_AT_ASC = { createdAt: 'asc' } as const
let cachedBrandIcon: Buffer | null = null

const readBrandIcon = (): Buffer | null => {
  if (cachedBrandIcon) return cachedBrandIcon
  const iconPath = resolve(process.cwd(), 'admin/public/icon-1024.png')
  if (!existsSync(iconPath)) return null
  cachedBrandIcon = readFileSync(iconPath)
  return cachedBrandIcon
}

export const registerAuthCoreRoutes = (
  app: FastifyInstance,
  deps: RouteDeps,
  issueRefreshCookie: IssueRefreshCookie,
): void => {
  const {
    authSecret,
    authenticateRequest,
    buildLocalSession,
    clearBootstrapState,
    config,
    getAuthorizationToken,
    prisma,
    rateLimiter,
    resolveBootstrapState,
  } = deps

  app.get('/api/auth/providers', { config: { public: true } }, async () =>
    createApiResponse(AuthProviderDescriptorSchema.array().parse(listAuthProviders(config))),
  )

  app.get('/api/auth/sso/config', { config: { public: true } }, async (request, reply) => {
    const query = parseInput(SsoConfigQuerySchema, request.query, reply)
    if (!query) return reply
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

  app.get(
    '/api/auth/providers/:providerId/authorize',
    { config: { public: true } },
    async (request, reply) => {
      const query = parseInput(AuthProviderAuthorizeQuerySchema, request.query, reply)
      if (!query) return reply
      // Brute-force guard on SSO authorize-URL minting (per-IP), same
      // surface as the OAuth state handshakes it initiates.
      if (
        !(await guardAuthRequest(
          rateLimiter,
          {
            bucket: RATE_LIMIT_BUCKETS.ssoAuthorizeIp,
            rule: config.api.rateLimit.mcpOauthIp,
          },
          request,
          reply,
        ))
      ) {
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
        return createApiResponse({
          authorizeUrl: await buildExternalAuthAuthorizeUrl(provider, query),
        })
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
    },
  )

  app.get('/api/auth/me', { config: { public: true } }, async (request, reply) => {
    const token = getAuthorizationToken(request)
    if (!token) {
      const state = await resolveBootstrapState()
      if (state) {
        return createApiResponse(BootstrapModeResponseSchema.parse({
          bootstrapMode: true,
          bootstrapUrl: '/bootstrap',
        }))
      }
      sendApiError(reply, 401, 'AUTH_REQUIRED', 'Authentication required')
      return reply
    }
    const authenticatedState = await authenticateRequest(request, reply)
    if (!authenticatedState) return reply
    return createApiResponse(MeResponseSchema.parse(authenticatedState.me))
  })

  app.patch('/api/auth/me/preferences', async (request, reply) => {
    const authenticatedState = await authenticateRequest(request, reply)
    if (!authenticatedState) return reply
    const body = parseInput(UpdatePreferencesSchema, request.body, reply)
    if (!body) return reply
    const existing = (authenticatedState.me.user.preferences ?? {}) as Record<string, unknown>
    const nextPreferences: Record<string, unknown> = { ...existing }
    for (const [key, value] of Object.entries(body)) {
      if (value === undefined) continue
      if (value === null) delete nextPreferences[key]
      else nextPreferences[key] = value
    }
    const updatedUser = await prisma.user.update({
      where: { id: authenticatedState.claims.sub },
      data: { preferences: nextPreferences as Prisma.InputJsonValue },
    })
    return createApiResponse(MeResponseSchema.parse(
      await buildMeResponse(prisma, updatedUser, authenticatedState.claims, config),
    ))
  })

  app.patch('/api/auth/me/avatar', async (request, reply) => {
    const authenticatedState = await authenticateRequest(request, reply)
    if (!authenticatedState) return reply
    // UnlikeOtherAI owns the profile of everyone who signs in through it, so a
    // UOA session cannot keep a local picture that would override the one UOA
    // holds. Those sessions change it at the source through the relay
    // (PUT/DELETE /api/auth/me/avatar/uoa); the local attachment path stays for
    // deployments with no UOA.
    if (authenticatedState.claims.providerType === 'uoa') {
      sendApiError(
        reply,
        403,
        'PROFILE_MANAGED_BY_SSO',
        'Your profile photo is managed in UnlikeOtherAI. Change it there or from this page, which updates UnlikeOtherAI directly.',
      )
      return reply
    }
    const body = parseInput(UpdateMyAvatarRequestSchema, request.body, reply)
    if (!body) return reply
    if (body.avatarAttachmentId) {
      const attachment = await prisma.attachment.findUnique({
        where: { id: body.avatarAttachmentId },
      })
      const organizationId = authenticatedState.actorContext.tenant.organizationId
      if (
        !attachment
        || !(await canAccessAttachment(prisma, attachment, {
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
    return createApiResponse(MeResponseSchema.parse(
      await buildMeResponse(prisma, updatedUser, authenticatedState.claims, config),
    ))
  })

  app.post('/api/auth/bootstrap', { config: { public: true } }, async (request, reply) => {
    const body = parseInput(BootstrapRequestSchema, request.body, reply)
    if (!body) return reply
    // Brute-force guard on the one-time owner bootstrap exchange (per-IP;
    // there is no account yet).
    if (
      !(await guardAuthRequest(
        rateLimiter,
        {
          bucket: RATE_LIMIT_BUCKETS.bootstrapIp,
          rule: config.api.rateLimit.bootstrapIp,
        },
        request,
        reply,
      ))
    ) {
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
      sendApiError(reply, 401, 'TOKEN_EXPIRED', 'Bootstrap token expired')
      return reply
    }
    if ((await prisma.user.count()) > 0) {
      clearBootstrapState()
      sendApiError(reply, 409, 'BOOTSTRAP_DISABLED', 'Bootstrap is no longer available')
      return reply
    }
    let result: Awaited<ReturnType<typeof seedBootstrapRecords>>
    try {
      result = await seedBootstrapRecords(prisma, {
        email: body.email,
        displayName: body.displayName,
        passwordHash: await hashPassword(body.password),
      })
    } catch (error) {
      if (!(error instanceof BootstrapAlreadyInitializedError)) throw error
      clearBootstrapState()
      sendApiError(reply, 409, 'BOOTSTRAP_DISABLED', 'Bootstrap is no longer available')
      return reply
    }
    clearBootstrapState()
    const session = await buildLocalSession(
      result.user.id,
      ['owner'],
      undefined,
      { userAgent: request.headers['user-agent'] ?? null },
    )
    const verification = verifySessionToken(session.token, authSecret)
    if (!verification.ok) {
      sendApiError(reply, 500, 'TOKEN_INVALID', 'Failed to issue bootstrap session')
      return reply
    }
    const actorContext = createActorContextFromClaims(verification.claims)
    await ensurePersonalAssistantBootstrap(prisma, {
      organizationId: actorContext.tenant.organizationId,
      teamId: actorContext.tenant.teamId!,
      userId: result.user.id,
    })
    await attemptGlobalAgentsBootstrap(
      prisma,
      {
        organizationId: actorContext.tenant.organizationId,
        teamId: actorContext.tenant.teamId!,
        userId: result.user.id,
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
      prisma,
    })
    await issueRefreshCookie(request, reply, {
      userId: result.user.id,
      organizationId: verification.claims.org,
      sessionId: session.sessionId,
      providerId: verification.claims.providerId,
      providerType: verification.claims.providerType,
    })
    return reply.code(201).send(createApiResponse({
      token: session.token,
      me: MeResponseSchema.parse(
        await buildMeResponse(prisma, result.user, verification.claims, config),
      ),
    }))
  })

  app.get('/api/auth/dev-login', { config: { public: true } }, async (request, reply) => {
    if (config.mode !== 'local') {
      sendApiError(reply, 403, 'FORBIDDEN', 'Dev login is only available in local mode')
      return reply
    }
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.ip)) {
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
    const session = await buildLocalSession(
      user.id,
      [organizationMember.role],
      undefined,
      { userAgent: request.headers['user-agent'] ?? null },
    )
    const verification = verifySessionToken(session.token, authSecret)
    if (!verification.ok) {
      sendApiError(reply, 500, 'TOKEN_INVALID', 'Failed to issue dev session')
      return reply
    }
    await issueRefreshCookie(request, reply, {
      userId: user.id,
      organizationId: verification.claims.org,
      sessionId: session.sessionId,
      providerId: verification.claims.providerId,
      providerType: verification.claims.providerType,
    })
    return createApiResponse({
      token: session.token,
      me: MeResponseSchema.parse(
        await buildMeResponse(prisma, user, verification.claims, config),
      ),
    })
  })

  registerAuthLogoutRoute(app, { authSecret, getAuthorizationToken, prisma })
}
