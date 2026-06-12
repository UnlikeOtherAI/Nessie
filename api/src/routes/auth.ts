import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import type { FastifyInstance } from 'fastify'

import { MeResponseSchema, UpdateMyAvatarRequestSchema, UpdatePreferencesSchema } from '@nessie/schemas'
import { isBootstrapTokenExpired } from '../auth/bootstrap.js'
import { hashPassword, verifyPassword } from '../auth/password.js'
import { verifySessionToken, type SessionTokenClaims } from '../auth/session.js'
import {
  AuthProviderAuthorizeQuerySchema,
  AuthProviderDescriptorSchema,
  BootstrapModeResponseSchema,
  BootstrapRequestSchema,
  LoginRequestSchema,
} from '../contracts.js'
import { seedBootstrapRecords } from '../db/seed.js'
import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import {
  LOCAL_AUTH_PROVIDER_ID, buildMeResponse, listAuthProviders, resolveConfiguredAuthProvider,
} from '../services/auth.js'
import { buildExternalAuthAuthorizeUrl, exchangeExternalAuthCode } from '../services/external-auth.js'
import { seedDefaultPolicies } from '../services/policy.js'
import { buildConfigJwt, buildPublicJwks, isUoaConfigured, loadUoaSettings } from '../services/uoa-auth.js'
import { createUserForOrganization, loadSessionUserByEmail } from '../services/users.js'
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

  app.get('/api/auth/providers', { config: { public: true } }, async () =>
    createApiResponse(AuthProviderDescriptorSchema.array().parse(listAuthProviders(config))),
  )

  // UOA (UnlikeOtherAuthenticator) integration endpoints. The signed config JWT
  // describes this deployment to UOA; the JWKS lets UOA verify it. Both are only
  // served when UOA is configured via env.
  app.get('/api/auth/sso/config', { config: { public: true } }, async (_request, reply) => {
    if (!isUoaConfigured()) {
      sendApiError(reply, 404, 'SSO_NOT_CONFIGURED', 'UOA SSO is not configured')
      return reply
    }
    return reply
      .header('content-type', 'application/jwt')
      .send(buildConfigJwt(loadUoaSettings()))
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

    const nextPreferences = Object.keys(body).length === 1 && body.theme
      ? { ...(authenticatedState.me.user.preferences ?? {}), theme: body.theme }
      : body

    const updatedUser = await prisma.user.update({
      where: { id: authenticatedState.claims.sub },
      data: { preferences: nextPreferences },
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
      if (!attachment || attachment.organizationId !== organizationId) {
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
        })

        let sessionUser = await loadSessionUserByEmail(prisma, identity.email)
        if (!sessionUser) {
          // Resolve the default org/project/team from DB for SSO auto-provisioning
          const defaultOrg = await prisma.organization.findFirst({ orderBy: CREATED_AT_ASC })
          const defaultProject = defaultOrg
            ? await prisma.project.findFirst({ where: { organizationId: defaultOrg.id }, orderBy: CREATED_AT_ASC })
            : null
          const defaultTeam = defaultProject
            ? await prisma.team.findFirst({ where: { projectId: defaultProject.id }, orderBy: CREATED_AT_ASC })
            : null
          const defaultChannel = defaultOrg
            ? await prisma.channel.findFirst({
                where: { organizationId: defaultOrg.id, visibility: 'public' },
                orderBy: CREATED_AT_ASC,
              })
            : null

          if (!defaultOrg || !defaultProject || !defaultTeam) {
            // Fresh instance with no workspace yet: the first SSO user bootstraps
            // the default org/project/team/channel and becomes its owner. This
            // makes SSO fully self-serve — no separate owner-account step.
            if ((await prisma.user.count()) === 0) {
              const seeded = await seedBootstrapRecords(prisma, {
                avatarUrl: identity.avatarUrl,
                displayName: identity.displayName,
                email: identity.email,
              })
              await seedDefaultPolicies(prisma, seeded.organizationId, seeded.user.id)
            } else {
              sendApiError(reply, 500, 'NO_DEFAULT_ORG', 'No organization configured for SSO provisioning')
              return reply
            }
          } else {
            await createUserForOrganization(prisma, {
              avatarUrl: identity.avatarUrl,
              channelIds: defaultChannel ? [defaultChannel.id] : [],
              displayName: identity.displayName,
              email: identity.email,
              organizationId: defaultOrg.id,
              projectId: defaultProject.id,
              role: 'member',
              teamId: defaultTeam.id,
            })
          }
          sessionUser = await loadSessionUserByEmail(prisma, identity.email)
        }

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

        const organizationMember = sessionUser.organizationMembers[0]
        const projectMember = sessionUser.projectMembers[0]
        const teamMember = sessionUser.teamMembers[0]
        if (!organizationMember || !projectMember || !teamMember) {
          sendApiError(reply, 403, 'FORBIDDEN', 'User is missing required workspace membership')
          return reply
        }

        const session = buildSessionForUser({
          organizationId: organizationMember.organizationId,
          projectId: projectMember.projectId,
          providerId: provider.providerId,
          providerType: provider.type,
          roles: [organizationMember.role],
          teamId: teamMember.teamId,
          userId: sessionUser.id,
        })
        const verification = verifySessionToken(session.token, authSecret)
        if (!verification.ok) {
          sendApiError(reply, 500, 'TOKEN_INVALID', 'Failed to issue external auth session')
          return reply
        }

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

    return createApiResponse({
      token: session.token,
      me: MeResponseSchema.parse(await buildMeResponse(prisma, user, verification.claims, config)),
    })
  })

  app.delete('/api/auth/session', async (_request, reply) => {
    reply.code(204)
    return null
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

    return createApiResponse({
      token: session.token,
      me: MeResponseSchema.parse(await buildMeResponse(prisma, user, verification.claims, config)),
    })
  })
}
