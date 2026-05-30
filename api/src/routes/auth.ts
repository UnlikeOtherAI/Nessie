import type { FastifyInstance } from 'fastify'

import { MeResponseSchema, UpdatePreferencesSchema } from '@nessie/schemas'
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
  LOCAL_AUTH_PROVIDER_ID,
  buildMeResponse,
  listAuthProviders,
  resolveConfiguredAuthProvider,
} from '../services/auth.js'
import {
  buildExternalAuthAuthorizeUrl,
  exchangeExternalAuthCode,
} from '../services/external-auth.js'
import { seedDefaultPolicies } from '../services/policy.js'
import {
  createUserForOrganization,
  loadSessionUserByEmail,
} from '../services/users.js'
import type { RouteDeps } from './types.js'

export const registerAuthRoutes = (app: FastifyInstance, deps: RouteDeps): void => {
  const {
    config,
    prisma,
    authSecret,
    DEFAULT_LOCAL_PROVIDER_TYPE,
    requireActorContext,
    resolveBootstrapState,
    clearBootstrapState,
    getAuthorizationToken,
    authenticateRequest,
    buildLocalSession,
    buildSessionForUser,
  } = deps

  app.get('/api/auth/providers', { config: { public: true } }, async () =>
    createApiResponse(
      AuthProviderDescriptorSchema.array().parse(listAuthProviders(config)),
    ),
  )

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
        return createApiResponse(BootstrapModeResponseSchema.parse({
          bootstrapMode: true,
          bootstrapUrl: '/bootstrap',
        }))
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

    const updatedUser = await prisma.user.update({
      where: { id: authenticatedState.claims.sub },
      data: { preferences: body },
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
          const defaultOrg = await prisma.organization.findFirst({ orderBy: { createdAt: 'asc' } })
          const defaultProject = defaultOrg
            ? await prisma.project.findFirst({
                where: { organizationId: defaultOrg.id },
                orderBy: { createdAt: 'asc' },
              })
            : null
          const defaultTeam = defaultProject
            ? await prisma.team.findFirst({
                where: { projectId: defaultProject.id },
                orderBy: { createdAt: 'asc' },
              })
            : null
          const defaultChannel = defaultOrg
            ? await prisma.channel.findFirst({
                where: { organizationId: defaultOrg.id, visibility: 'public' },
                orderBy: { createdAt: 'asc' },
              })
            : null

          if (!defaultOrg || !defaultProject || !defaultTeam) {
            sendApiError(reply, 500, 'NO_DEFAULT_ORG', 'No organization configured for SSO provisioning')
            return reply
          }

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
          sessionUser = await loadSessionUserByEmail(prisma, identity.email)
        }

        if (!sessionUser) {
          sendApiError(reply, 500, 'USER_NOT_FOUND', 'Failed to load authenticated user')
          return reply
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
          me: MeResponseSchema.parse(await buildMeResponse(prisma,sessionUser, verification.claims, config)),
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
      me: MeResponseSchema.parse(await buildMeResponse(prisma,user, verification.claims, config)),
    })
  })

  app.get('/api/auth/dev-login', { config: { public: true } }, async (request, reply) => {
    if (config.mode !== 'local') {
      sendApiError(reply, 403, 'FORBIDDEN', 'Dev login is only available in local mode')
      return reply
    }

    const remoteIp = request.ip
    const isLoopback =
      remoteIp === '127.0.0.1'
      || remoteIp === '::1'
      || remoteIp === '::ffff:127.0.0.1'
    if (!isLoopback) {
      sendApiError(reply, 403, 'FORBIDDEN', 'Dev login is only available from localhost')
      return reply
    }

    const user = await prisma.user.findFirst({
      include: {
        organizationMembers: true,
        projectMembers: true,
        teamMembers: true,
      },
      orderBy: { createdAt: 'asc' },
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
      me: MeResponseSchema.parse(await buildMeResponse(prisma,user, verification.claims, config)),
    })
  })

  app.delete('/api/auth/session', async (_request, reply) => {
    reply.code(204)
    return null
  })

  app.post('/api/auth/switch-context', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply

    const body = request.body as {
      organizationId?: string
      projectId?: string
      teamId?: string
    } | undefined

    if (!body?.organizationId || !body?.projectId || !body?.teamId) {
      sendApiError(reply, 400, 'INVALID_INPUT', 'organizationId, projectId, and teamId are required')
      return reply
    }

    // Verify membership
    const orgMember = await prisma.organizationMember.findUnique({
      where: { organizationId_userId: { organizationId: body.organizationId, userId: actorContext.actor.actorId } },
    })
    if (!orgMember) {
      sendApiError(reply, 403, 'NOT_A_MEMBER', 'Not a member of this organization')
      return reply
    }

    const project = await prisma.project.findUnique({ where: { id: body.projectId } })
    if (!project || project.organizationId !== body.organizationId) {
      sendApiError(reply, 403, 'NOT_A_MEMBER', 'Not a member of this project/team')
      return reply
    }

    const projectMember = await prisma.projectMember.findUnique({
      where: {
        projectId_userId: {
          projectId: body.projectId,
          userId: actorContext.actor.actorId,
        },
      },
    })
    if (!projectMember) {
      sendApiError(reply, 403, 'NOT_A_MEMBER', 'Not a member of this project/team')
      return reply
    }

    const team = await prisma.team.findUnique({ where: { id: body.teamId } })
    if (!team || team.projectId !== body.projectId) {
      sendApiError(reply, 403, 'NOT_A_MEMBER', 'Not a member of this project/team')
      return reply
    }

    const teamMember = await prisma.teamMember.findUnique({
      where: {
        teamId_userId: {
          teamId: body.teamId,
          userId: actorContext.actor.actorId,
        },
      },
    })
    if (!teamMember) {
      sendApiError(reply, 403, 'NOT_A_MEMBER', 'Not a member of this project/team')
      return reply
    }

    const session = buildSessionForUser({
      organizationId: body.organizationId,
      projectId: body.projectId,
      providerId: LOCAL_AUTH_PROVIDER_ID,
      providerType: DEFAULT_LOCAL_PROVIDER_TYPE as SessionTokenClaims['providerType'],
      roles: [orgMember.role],
      teamId: body.teamId,
      userId: actorContext.actor.actorId,
    })

    const verification = verifySessionToken(session.token, authSecret)
    if (!verification.ok) {
      sendApiError(reply, 500, 'TOKEN_INVALID', 'Failed to issue new session')
      return reply
    }

    const user = await prisma.user.findUnique({ where: { id: actorContext.actor.actorId } })
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
