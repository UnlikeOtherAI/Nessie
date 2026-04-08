import { existsSync, readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

// Load .env from project root (parent of api/) before config is parsed
const envFile = resolve(import.meta.dirname, '../../.env')
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq < 1) continue
    const key = trimmed.slice(0, eq).trim()
    const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '')
    if (!(key in process.env)) process.env[key] = val
  }
}
import cors from '@fastify/cors'
import websocket from '@fastify/websocket'
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify'
import { loadConfig } from '@nessie/config'
import { createPgPool } from '@nessie/runtime'
import {
  CaptureThoughtBodySchema,
  LinkThoughtsBodySchema,
  MeResponseSchema,
  RecordThoughtRecallSignalBodySchema,
  RecordOutcomeBodySchema,
  SearchThoughtsBodySchema,
  WsClientMessageSchema,
  parseAgentId,
  parseChannelId,
  parseOrganizationId,
  parseRunId,
  parseTaskId,
  parseThreadId,
  type AuthorizedActionContext,
  type MeResponse,
  type WsScope,
} from '@nessie/schemas'
import {
  createBootstrapTokenState,
  isBootstrapTokenExpired,
  type BootstrapTokenState,
} from './auth/bootstrap.js'
import { hashPassword, verifyPassword } from './auth/password.js'
import {
  issueSessionToken,
  verifySessionToken,
  type SessionTokenClaims,
} from './auth/session.js'
import {
  AddChannelMemberBodySchema,
  AgentCategoryAgentBodySchema,
  AgentCategoryRecordSchema,
  AgentRecordSchema,
  AuthProviderAuthorizeQuerySchema,
  AuthProviderDescriptorSchema,
  BootstrapModeResponseSchema,
  BootstrapRequestSchema,
  ChannelRecordSchema,
  CreateAgentBindingBodySchema,
  CreateAgentBodySchema,
  CreateAgentCategoryBodySchema,
  DesignerChatBodySchema,
  CreateChannelBodySchema,
  CreateThreadMessageBodySchema,
  CreateUserBodySchema,
  LoginRequestSchema,
  ThreadMessageRecordSchema,
  ToolDescriptorSchema,
  UpdateAgentCategoryBodySchema,
  UserRecordSchema,
} from './contracts.js'
import { DEFAULT_BOOTSTRAP_RECORD_IDS } from './db/bootstrap.js'
import { getPrismaClient } from './db/client.js'
import { seedBootstrapRecords } from './db/seed.js'
import { createApiResponse, parseInput, sendApiError } from './lib/api.js'
import { enqueueRunExecution } from './queue/pgqueue.js'
import { createRealtimeHub } from './realtime/hub.js'
import {
  addAgentToCategory,
  createAgentCategory,
  deleteAgentCategory,
  listAgentCategories,
  removeAgentFromCategory,
  updateAgentCategory,
} from './services/agent-categories.js'
import {
  bindAgentToChannel,
  buildSnapshotForScopes,
  cloneAgentRecord,
  createAgentRecord,
  listAgentsForUser,
  loadAgentActivity,
  loadAgentChildren,
  loadAgentMessages,
  loadAgentStatus,
  loadRunToolCalls,
  unbindAgentFromChannel,
} from './services/agents.js'
import { streamDesignerChat } from './services/designer.js'
import {
  LOCAL_AUTH_PROVIDER_ID,
  buildMeResponse,
  createActorContextFromClaims,
  listAuthProviders,
  resolveConfiguredAuthProvider,
} from './services/auth.js'
import {
  addMemberToChannel,
  createChannelForUser,
  listChannelsForUser,
  removeMemberFromChannel,
} from './services/channels.js'
import {
  buildExternalAuthAuthorizeUrl,
  exchangeExternalAuthCode,
} from './services/external-auth.js'
import {
  createThreadMessage,
  findThreadForUser,
  listThreadMessages,
} from './services/messages.js'
import { createThoughtService } from './services/thoughts.js'
import { listSafeTools } from './services/tools.js'
import {
  createUserForOrganization,
  listUsersForOrganization,
  loadSessionUserByEmail,
} from './services/users.js'

type AuthenticatedRequestState = {
  actorContext: AuthorizedActionContext
  claims: SessionTokenClaims
  me: MeResponse
}

const DEFAULT_LOCAL_PROVIDER_TYPE = 'local-bootstrap'

const config = loadConfig()
if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = config.database.url
}
const databaseUrl = process.env.DATABASE_URL
const prisma = getPrismaClient()
const authSecret = config.auth.secret ?? randomUUID()
let bootstrapTokenState: BootstrapTokenState | null = null

const resolveBootstrapState = async (): Promise<BootstrapTokenState | null> => {
  const usersExist = (await prisma.user.count()) > 0
  if (usersExist) {
    bootstrapTokenState = null
    return null
  }

  if (!bootstrapTokenState || isBootstrapTokenExpired(bootstrapTokenState)) {
    bootstrapTokenState = createBootstrapTokenState()
  }

  return bootstrapTokenState
}

const logBootstrapUrl = (state: BootstrapTokenState): void => {
  const baseUrl = `http://${config.api.host === '0.0.0.0' ? 'localhost' : config.api.host}:${config.api.port}`
  console.log('First-time setup. Open this URL to create your owner account:')
  console.log(`${baseUrl}/admin/bootstrap?token=${state.token}`)
}

const getAuthorizationToken = (request: FastifyRequest): string | null => {
  const header = request.headers.authorization
  if (header) {
    const [scheme, token] = header.split(' ')
    if (scheme === 'Bearer' && token) {
      return token
    }
  }

  const queryToken =
    (request.query as { token?: string } | undefined)?.token ??
    new URL(request.url, 'http://localhost').searchParams.get('token')

  if (typeof queryToken === 'string' && queryToken.length > 0) {
    return queryToken
  }

  return null
}

const authenticateRequest = async (
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<AuthenticatedRequestState | null> => {
  const token = getAuthorizationToken(request)
  if (!token) {
    sendApiError(reply, 401, 'AUTH_REQUIRED', 'Missing or invalid authorization header')
    return null
  }

  const verification = verifySessionToken(token, authSecret)
  if (!verification.ok) {
    sendApiError(reply, 401, verification.code, verification.message)
    return null
  }

  const user = await prisma.user.findUnique({
    where: { id: verification.claims.sub },
  })

  if (!user) {
    sendApiError(reply, 401, 'USER_NOT_FOUND', 'User no longer exists')
    return null
  }

  const actorContext = createActorContextFromClaims(verification.claims)
  request.actorContext = actorContext

  return {
    actorContext,
    claims: verification.claims,
    me: buildMeResponse(user, verification.claims, config),
  }
}

const requireActorContext = (
  request: FastifyRequest,
  reply: FastifyReply,
): AuthorizedActionContext | null => {
  if (request.actorContext) {
    return request.actorContext
  }

  sendApiError(reply, 401, 'AUTH_REQUIRED', 'Authentication required')
  return null
}

const requireOwner = (
  actorContext: AuthorizedActionContext,
  reply: FastifyReply,
): boolean => {
  if (actorContext.actor.roles?.includes('owner')) {
    return true
  }

  sendApiError(reply, 403, 'FORBIDDEN', 'Owner access required')
  return false
}

const withActionContext = (
  actorContext: AuthorizedActionContext,
  fields: Partial<AuthorizedActionContext['actionContext']>,
): AuthorizedActionContext => ({
  ...actorContext,
  actionContext: {
    ...actorContext.actionContext,
    ...fields,
  },
})

const isAgentVisibleToUser = async (userId: string, agentId: string): Promise<boolean> =>
  (await prisma.agent.count({
    where: {
      id: agentId,
      bindings: {
        some: {
          channel: {
            members: {
              some: { userId },
            },
          },
        },
      },
    },
  })) > 0

const isChannelVisibleToUser = async (userId: string, channelId: string): Promise<boolean> =>
  (await prisma.channel.count({
    where: {
      id: channelId,
      members: {
        some: { userId },
      },
    },
  })) > 0

const filterAuthorizedScopes = async (
  userId: string,
  tenantOrganizationId: string,
  scopes: WsScope[],
): Promise<WsScope[]> => {
  const authorizedScopes: WsScope[] = []

  for (const scope of scopes) {
    if (scope.kind === 'organization') {
      if (scope.organizationId === parseOrganizationId(tenantOrganizationId)) {
        authorizedScopes.push(scope)
      }
      continue
    }

    if (scope.kind === 'channel') {
      if (await isChannelVisibleToUser(userId, scope.channelId)) {
        authorizedScopes.push(scope)
      }
      continue
    }

    if (await isAgentVisibleToUser(userId, scope.agentId)) {
      authorizedScopes.push(scope)
    }
  }

  return authorizedScopes
}

const buildLocalSession = (userId: string, roles: string[]) =>
  issueSessionToken(
    {
      sub: userId,
      org: '00000000-0000-4000-8000-000000000001',
      proj: '00000000-0000-4000-8000-000000000002',
      team: '00000000-0000-4000-8000-000000000003',
      roles,
      providerId: LOCAL_AUTH_PROVIDER_ID,
      providerType: DEFAULT_LOCAL_PROVIDER_TYPE,
    },
    authSecret,
    config.auth.tokenTtlSeconds,
  )

const buildSessionForUser = (input: {
  organizationId: string
  projectId: string
  providerId: string
  providerType: SessionTokenClaims['providerType']
  roles: string[]
  teamId: string
  userId: string
}) =>
  issueSessionToken(
    {
      sub: input.userId,
      org: input.organizationId,
      proj: input.projectId,
      team: input.teamId,
      roles: input.roles,
      providerId: input.providerId,
      providerType: input.providerType,
    },
    authSecret,
    config.auth.tokenTtlSeconds,
  )

export const buildApp = async () => {
  const app = Fastify({ logger: true })
  const realtimeHub = await createRealtimeHub({
    databaseUrl,
    poolMax: config.database.poolMax,
    poolMin: config.database.poolMin,
  })

  const memoryPool = createPgPool(databaseUrl, {
    max: config.database.poolMax,
    min: config.database.poolMin,
  })
  const openaiApiKey = process.env.OPENAI_API_KEY ?? ''
  if (!openaiApiKey) {
    app.log.warn('OPENAI_API_KEY not set — memory capture and search will fail')
  }
  const embeddingConfig = { apiKey: openaiApiKey }
  const extractionConfig = { apiKey: openaiApiKey }
  const thoughtService = createThoughtService({
    pool: memoryPool,
    captureConfig: { pool: memoryPool, embedding: embeddingConfig, extraction: extractionConfig },
    searchConfig: { pool: memoryPool, embedding: embeddingConfig },
  })

  await app.register(cors, { origin: true, credentials: true })
  await app.register(websocket)

  app.decorateRequest('actorContext', null)

  app.addHook('onClose', async () => {
    await realtimeHub.close()
    await memoryPool.end()
    await prisma.$disconnect()
  })

  app.addHook('preHandler', async (request, reply) => {
    if (request.routeOptions.config.public === true) {
      return
    }

    await authenticateRequest(request, reply)
  })

  app.get('/api/health', { config: { public: true } }, async () =>
    createApiResponse({
      service: 'api',
      status: 'ok',
    }),
  )

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
          bootstrapUrl: '/admin/bootstrap',
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
      bootstrapTokenState = null
      sendApiError(reply, 401, 'TOKEN_EXPIRED', 'Bootstrap token expired')
      return reply
    }

    if ((await prisma.user.count()) > 0) {
      bootstrapTokenState = null
      sendApiError(reply, 409, 'BOOTSTRAP_DISABLED', 'Bootstrap is no longer available')
      return reply
    }

    const passwordHash = await hashPassword(body.password)
    const result = await seedBootstrapRecords(prisma, {
      email: body.email,
      displayName: body.displayName,
      passwordHash,
    })
    bootstrapTokenState = null

    const session = buildLocalSession(result.user.id, ['owner'])
    const verification = verifySessionToken(session.token, authSecret)
    if (!verification.ok) {
      sendApiError(reply, 500, 'TOKEN_INVALID', 'Failed to issue bootstrap session')
      return reply
    }

    return reply.code(201).send(
      createApiResponse({
        token: session.token,
        me: MeResponseSchema.parse(buildMeResponse(result.user, verification.claims, config)),
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
          await createUserForOrganization(prisma, {
            avatarUrl: identity.avatarUrl,
            channelIds: [DEFAULT_BOOTSTRAP_RECORD_IDS.channelId],
            displayName: identity.displayName,
            email: identity.email,
            organizationId: DEFAULT_BOOTSTRAP_RECORD_IDS.organizationId,
            projectId: DEFAULT_BOOTSTRAP_RECORD_IDS.projectId,
            role: 'member',
            teamId: DEFAULT_BOOTSTRAP_RECORD_IDS.teamId,
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
          me: MeResponseSchema.parse(buildMeResponse(sessionUser, verification.claims, config)),
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
    const session = buildLocalSession(user.id, sessionRoles)
    const verification = verifySessionToken(session.token, authSecret)
    if (!verification.ok) {
      sendApiError(reply, 500, 'TOKEN_INVALID', 'Failed to issue session')
      return reply
    }

    return createApiResponse({
      token: session.token,
      me: MeResponseSchema.parse(buildMeResponse(user, verification.claims, config)),
    })
  })

  app.delete('/api/auth/session', async (_request, reply) => {
    reply.code(204)
    return null
  })

  app.get('/api/channels', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    const channels = await listChannelsForUser(
      prisma,
      actorContext.actor.actorId,
      actorContext.tenant.organizationId,
    )

    return createApiResponse(ChannelRecordSchema.array().parse(channels))
  })

  app.post('/api/channels', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    const body = parseInput(CreateChannelBodySchema, request.body, reply)
    if (!body) {
      return reply
    }

    const channel = await createChannelForUser(prisma, {
      label: body.label,
      visibility: body.visibility ?? 'public',
      organizationId: actorContext.tenant.organizationId,
      teamId: actorContext.tenant.teamId ?? actorContext.actionContext.teamId ?? '00000000-0000-4000-8000-000000000003',
      userId: actorContext.actor.actorId,
    })

    return reply.code(201).send(createApiResponse(ChannelRecordSchema.parse(channel)))
  })

  app.post('/api/channels/:channelId/members', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    const { channelId } = request.params as { channelId: string }
    if (!(await isChannelVisibleToUser(actorContext.actor.actorId, channelId))) {
      sendApiError(reply, 404, 'CHANNEL_NOT_FOUND', 'Channel not found')
      return reply
    }

    const body = parseInput(AddChannelMemberBodySchema, request.body, reply)
    if (!body) {
      return reply
    }

    await addMemberToChannel(prisma, channelId, body.userId)
    return reply.code(204).send()
  })

  app.delete('/api/channels/:channelId/members/:userId', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    const { channelId, userId } = request.params as { channelId: string; userId: string }
    if (!(await isChannelVisibleToUser(actorContext.actor.actorId, channelId))) {
      sendApiError(reply, 404, 'CHANNEL_NOT_FOUND', 'Channel not found')
      return reply
    }

    await removeMemberFromChannel(prisma, channelId, userId)
    return reply.code(204).send()
  })

  app.get('/api/agents', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    const isOwner = actorContext.actor.roles?.includes('owner') ?? false
    const agents = await listAgentsForUser(
      prisma,
      actorContext.actor.actorId,
      actorContext.tenant.organizationId,
      isOwner,
    )
    return createApiResponse(AgentRecordSchema.array().parse(agents))
  })

  app.post('/api/agents', async (request, reply) => {
    if (!requireActorContext(request, reply)) {
      return reply
    }

    const body = parseInput(CreateAgentBodySchema, request.body, reply)
    if (!body) {
      return reply
    }

    const agent = await createAgentRecord(prisma, {
      model: body.model,
      name: body.name,
      parentAgentId: body.parentAgentId,
      provider: body.provider,
      role: body.role ?? 'assistant',
      systemPrompt: body.systemPrompt,
      toolPolicy: body.toolPolicy,
    })

    return reply.code(201).send(createApiResponse(AgentRecordSchema.parse(agent)))
  })

  app.post('/api/agents/:agentId/bindings', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    const body = parseInput(CreateAgentBindingBodySchema, request.body, reply)
    if (!body) {
      return reply
    }

    if (!(await isChannelVisibleToUser(actorContext.actor.actorId, body.channelId))) {
      sendApiError(reply, 404, 'CHANNEL_NOT_FOUND', 'Channel not found')
      return reply
    }

    const { agentId } = request.params as { agentId: string }
    const agent = await bindAgentToChannel(prisma, agentId, body.channelId)
    if (!agent) {
      sendApiError(reply, 404, 'AGENT_NOT_FOUND', 'Agent not found')
      return reply
    }

    return createApiResponse(AgentRecordSchema.parse(agent))
  })

  app.delete('/api/agents/:agentId/bindings/:channelId', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    const { agentId, channelId } = request.params as { agentId: string; channelId: string }
    if (!(await isChannelVisibleToUser(actorContext.actor.actorId, channelId))) {
      sendApiError(reply, 404, 'CHANNEL_NOT_FOUND', 'Channel not found')
      return reply
    }

    await unbindAgentFromChannel(prisma, agentId, channelId)
    return reply.code(204).send()
  })

  app.post('/api/agents/:agentId/clone', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    const { agentId } = request.params as { agentId: string }
    if (!(await isAgentVisibleToUser(actorContext.actor.actorId, agentId))) {
      sendApiError(reply, 404, 'AGENT_NOT_FOUND', 'Agent not found')
      return reply
    }

    const cloned = await cloneAgentRecord(prisma, agentId)
    if (!cloned) {
      sendApiError(reply, 404, 'AGENT_NOT_FOUND', 'Agent not found')
      return reply
    }

    return reply.code(201).send(createApiResponse(AgentRecordSchema.parse(cloned)))
  })

  // ─── Agent Categories ─────────────────────────────────────────────────────

  app.get('/api/agent-categories', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply

    const categories = await listAgentCategories(
      prisma,
      actorContext.tenant.organizationId,
    )
    return createApiResponse(
      AgentCategoryRecordSchema.array().parse(categories),
    )
  })

  app.post('/api/agent-categories', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply

    const body = parseInput(CreateAgentCategoryBodySchema, request.body, reply)
    if (!body) return reply

    const category = await createAgentCategory(prisma, {
      name: body.name,
      description: body.description,
      visibility: body.visibility ?? 'public',
      organizationId: actorContext.tenant.organizationId,
      createdById: actorContext.actor.actorId,
      authorAgentId: body.authorAgentId,
    })

    return reply
      .code(201)
      .send(createApiResponse(AgentCategoryRecordSchema.parse(category)))
  })

  app.put('/api/agent-categories/:categoryId', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply

    const body = parseInput(
      UpdateAgentCategoryBodySchema,
      request.body,
      reply,
    )
    if (!body) return reply

    const { categoryId } = request.params as { categoryId: string }
    const category = await updateAgentCategory(prisma, categoryId, body)
    if (!category) {
      sendApiError(reply, 404, 'CATEGORY_NOT_FOUND', 'Category not found')
      return reply
    }

    return createApiResponse(AgentCategoryRecordSchema.parse(category))
  })

  app.delete('/api/agent-categories/:categoryId', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply

    const { categoryId } = request.params as { categoryId: string }
    const deleted = await deleteAgentCategory(prisma, categoryId)
    if (!deleted) {
      sendApiError(reply, 404, 'CATEGORY_NOT_FOUND', 'Category not found')
      return reply
    }

    return reply.code(204).send()
  })

  app.post(
    '/api/agent-categories/:categoryId/agents',
    async (request, reply) => {
      const actorContext = requireActorContext(request, reply)
      if (!actorContext) return reply

      const body = parseInput(AgentCategoryAgentBodySchema, request.body, reply)
      if (!body) return reply

      const { categoryId } = request.params as { categoryId: string }
      const category = await addAgentToCategory(
        prisma,
        categoryId,
        body.agentId,
      )
      if (!category) {
        sendApiError(reply, 404, 'CATEGORY_NOT_FOUND', 'Category not found')
        return reply
      }

      return createApiResponse(AgentCategoryRecordSchema.parse(category))
    },
  )

  app.delete(
    '/api/agent-categories/:categoryId/agents/:agentId',
    async (request, reply) => {
      const actorContext = requireActorContext(request, reply)
      if (!actorContext) return reply

      const { categoryId, agentId } = request.params as {
        agentId: string
        categoryId: string
      }
      const removed = await removeAgentFromCategory(
        prisma,
        categoryId,
        agentId,
      )
      if (!removed) {
        sendApiError(
          reply,
          404,
          'LINK_NOT_FOUND',
          'Agent is not in this category',
        )
        return reply
      }

      return reply.code(204).send()
    },
  )

  app.get('/api/tools', async () =>
    createApiResponse(ToolDescriptorSchema.array().parse(listSafeTools())),
  )

  app.get('/api/users', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    if (!requireOwner(actorContext, reply)) {
      return reply
    }

    const users = await listUsersForOrganization(prisma, actorContext.tenant.organizationId)
    return createApiResponse(UserRecordSchema.array().parse(users))
  })

  app.post('/api/users', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    if (!requireOwner(actorContext, reply)) {
      return reply
    }

    const body = parseInput(CreateUserBodySchema, request.body, reply)
    if (!body) {
      return reply
    }

    try {
      const passwordHash = await hashPassword(body.password)
      const user = await createUserForOrganization(prisma, {
        channelIds: body.channelIds,
        displayName: body.displayName,
        email: body.email,
        organizationId: actorContext.tenant.organizationId,
        passwordHash,
        projectId:
          actorContext.tenant.projectId ??
          '00000000-0000-4000-8000-000000000002',
        role: body.role ?? 'member',
        teamId:
          actorContext.tenant.teamId ??
          actorContext.actionContext.teamId ??
          '00000000-0000-4000-8000-000000000003',
      })

      return reply.code(201).send(createApiResponse(UserRecordSchema.parse(user)))
    } catch (error) {
      if (error instanceof Error && error.message === 'USER_ALREADY_EXISTS') {
        sendApiError(reply, 409, 'USER_ALREADY_EXISTS', 'A user with that email already exists')
        return reply
      }

      throw error
    }
  })

  app.get('/api/threads/:threadId/messages', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    const { threadId } = request.params as { threadId: string }
    const thread = await findThreadForUser(prisma, threadId, actorContext.actor.actorId)
    if (!thread) {
      sendApiError(reply, 404, 'THREAD_NOT_FOUND', 'Thread not found')
      return reply
    }

    const messages = await listThreadMessages(prisma, thread.id)
    return createApiResponse(ThreadMessageRecordSchema.array().parse(messages))
  })

  app.post('/api/threads/:threadId/messages', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    const body = parseInput(CreateThreadMessageBodySchema, request.body, reply)
    if (!body) {
      return reply
    }

    const { threadId } = request.params as { threadId: string }
    const thread = await findThreadForUser(prisma, threadId, actorContext.actor.actorId)
    if (!thread) {
      sendApiError(reply, 404, 'THREAD_NOT_FOUND', 'Thread not found')
      return reply
    }

    const result = await createThreadMessage(prisma, {
      agentId: body.agentId,
      content: body.content,
      threadId: thread.id,
      userId: actorContext.actor.actorId,
    })

    if (result.kind === 'thread_not_found') {
      sendApiError(reply, 404, 'THREAD_NOT_FOUND', 'Thread not found')
      return reply
    }

    if (result.kind === 'agent_not_bound') {
      sendApiError(reply, 404, 'AGENT_NOT_FOUND', 'Agent is not bound to this channel')
      return reply
    }

    const messageAgentId = result.run?.agentId ?? body.agentId
    if (messageAgentId) {
      await realtimeHub.publishWs(
        [
          {
            kind: 'organization',
            organizationId: actorContext.tenant.organizationId,
          },
          {
            kind: 'channel',
            channelId: parseChannelId(thread.channel.id),
          },
          {
            kind: 'agent',
            agentId: parseAgentId(messageAgentId),
          },
        ],
        {
          data: {
            agentId: parseAgentId(messageAgentId),
            contentPreview: result.message.content.slice(0, 200),
            messageId: result.message.id,
            role: result.message.role,
            threadId: parseThreadId(result.message.threadId),
          },
          event: 'message.new',
        },
      )
    }

    if (result.run && result.task) {
      await enqueueRunExecution(prisma, {
        actorContext: withActionContext(actorContext, {
          agentId: parseAgentId(result.run.agentId),
          channelId: parseChannelId(thread.channel.id),
          taskId: parseTaskId(result.task.id),
          threadId: parseThreadId(result.run.threadId),
        }),
        agentId: parseAgentId(result.run.agentId),
        messageId: result.message.id,
        runId: parseRunId(result.run.id),
        taskId: parseTaskId(result.task.id),
        threadId: parseThreadId(result.run.threadId),
      })
    }

    return reply.code(201).send(
      createApiResponse(
        ThreadMessageRecordSchema.parse({
          id: result.message.id,
          threadId: result.message.threadId,
          agentId: result.message.agentId ?? undefined,
          userId: result.message.userId ?? undefined,
          role: result.message.role,
          content: result.message.content,
          createdAt: result.message.createdAt.toISOString(),
        }),
      ),
    )
  })

  app.get('/api/threads/:threadId/stream', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    const { threadId } = request.params as { threadId: string }
    const thread = await findThreadForUser(prisma, threadId, actorContext.actor.actorId)
    if (!thread) {
      sendApiError(reply, 404, 'THREAD_NOT_FOUND', 'Thread not found')
      return reply
    }

    reply.hijack()
    reply.raw.writeHead(200, {
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'Content-Type': 'text/event-stream',
    })
    reply.raw.write(': stream connected\n\n')

    const lastEventIdHeader = request.headers['last-event-id']
    const lastEventId = Array.isArray(lastEventIdHeader)
      ? lastEventIdHeader[0]
      : lastEventIdHeader

    const streamConnection = await realtimeHub.addSseConnection(
      thread.id,
      reply.raw,
      lastEventId,
    )

    const keepAlive = setInterval(() => {
      reply.raw.write(': keepalive\n\n')
    }, 15000)

    request.raw.on('close', () => {
      clearInterval(keepAlive)
      realtimeHub.removeSseConnection(streamConnection)
      reply.raw.end()
    })
  })

  app.get('/api/agents/:agentId/status', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    const { agentId } = request.params as { agentId: string }
    if (!(await isAgentVisibleToUser(actorContext.actor.actorId, agentId))) {
      sendApiError(reply, 404, 'AGENT_NOT_FOUND', 'Agent not found')
      return reply
    }

    const status = await loadAgentStatus(prisma, agentId)
    if (!status) {
      sendApiError(reply, 404, 'AGENT_NOT_FOUND', 'Agent not found')
      return reply
    }

    return createApiResponse(status)
  })

  app.get('/api/agents/:agentId/activity', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    const { agentId } = request.params as { agentId: string }
    if (!(await isAgentVisibleToUser(actorContext.actor.actorId, agentId))) {
      sendApiError(reply, 404, 'AGENT_NOT_FOUND', 'Agent not found')
      return reply
    }

    const activity = await loadAgentActivity(prisma, agentId)
    if (!activity) {
      sendApiError(reply, 404, 'AGENT_NOT_FOUND', 'Agent not found')
      return reply
    }

    return createApiResponse(activity)
  })

  app.get('/api/agents/:agentId/messages', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    const { agentId } = request.params as { agentId: string }
    const limit = Math.min(Math.max(Number((request.query as { limit?: string }).limit ?? '5'), 1), 50)
    if (!(await isAgentVisibleToUser(actorContext.actor.actorId, agentId))) {
      sendApiError(reply, 404, 'AGENT_NOT_FOUND', 'Agent not found')
      return reply
    }

    return createApiResponse(await loadAgentMessages(prisma, agentId, limit))
  })

  app.get('/api/agents/:agentId/children', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    const { agentId } = request.params as { agentId: string }
    if (!(await isAgentVisibleToUser(actorContext.actor.actorId, agentId))) {
      sendApiError(reply, 404, 'AGENT_NOT_FOUND', 'Agent not found')
      return reply
    }

    return createApiResponse(await loadAgentChildren(prisma, agentId))
  })

  app.get('/api/agents/:agentId/runs/:runId/tools', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    const { agentId, runId } = request.params as { agentId: string; runId: string }
    if (!(await isAgentVisibleToUser(actorContext.actor.actorId, agentId))) {
      sendApiError(reply, 404, 'AGENT_NOT_FOUND', 'Agent not found')
      return reply
    }

    return createApiResponse(await loadRunToolCalls(prisma, agentId, runId))
  })

  app.get('/api/activity', { websocket: true }, (socket, request) => {
    const actorContext = request.actorContext
    if (!actorContext) {
      socket.close(4001, 'Authentication required')
      return
    }

    const userId = actorContext.actor.actorId
    const tenantOrganizationId = actorContext.tenant.organizationId
    const wsConnection = realtimeHub.registerWsConnection((message) => {
      sendJson(message)
    })
    let currentScopes: WsScope[] = []
    let idleTimer: NodeJS.Timeout

    const resetIdleTimer = () => {
      clearTimeout(idleTimer)
      idleTimer = setTimeout(() => {
        socket.close(4002, 'Idle timeout')
      }, 60000)
    }

    const sendJson = (value: unknown) => {
      socket.send(JSON.stringify(value))
    }

    resetIdleTimer()

    socket.on('message', async (rawMessage: Buffer) => {
      resetIdleTimer()

      let payload: unknown
      try {
        payload = JSON.parse(rawMessage.toString())
      } catch {
        sendJson({ type: 'error', code: 'INVALID_JSON', message: 'Invalid JSON payload' })
        return
      }

      const parsed = WsClientMessageSchema.safeParse(payload)
      if (!parsed.success) {
        sendJson({ type: 'error', code: 'INVALID_MESSAGE', message: 'Invalid WebSocket message' })
        return
      }

      if (parsed.data.type === 'ping') {
        sendJson({ type: 'pong', ts: new Date().toISOString() })
        return
      }

      if (parsed.data.type === 'unsubscribe') {
        const requested = new Set(parsed.data.scopes.map((scope) => JSON.stringify(scope)))
        currentScopes = currentScopes.filter((scope) => !requested.has(JSON.stringify(scope)))
        realtimeHub.setWsScopes(wsConnection, currentScopes)
        return
      }

      const nextScopes =
        parsed.data.type === 'set_subscriptions'
          ? parsed.data.scopes
          : [...currentScopes, ...parsed.data.scopes]

      currentScopes = await filterAuthorizedScopes(userId, tenantOrganizationId, nextScopes)
      realtimeHub.setWsScopes(wsConnection, currentScopes)
      const snapshot = await buildSnapshotForScopes(prisma, currentScopes)

      sendJson({
        type: 'subscribed',
        scopes: currentScopes,
        snapshot,
      })
    })

    socket.on('close', () => {
      clearTimeout(idleTimer)
      realtimeHub.removeWsConnection(wsConnection)
    })
  })

  // ─── Memory / Thoughts Routes ────────────────────────────────────────────

  app.post('/api/thoughts', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    const body = parseInput(CaptureThoughtBodySchema, request.body, reply)
    if (!body) {
      return reply
    }

    const result = await thoughtService.capture({
      content: body.content,
      ownerId: actorContext.actor.actorId,
      ownerType: actorContext.actor.actorType,
      organizationId: actorContext.tenant.organizationId,
      projectId: body.projectId ?? actorContext.tenant.projectId,
      teamId: body.teamId ?? actorContext.tenant.teamId,
      channelId: body.channelId ?? actorContext.tenant.channelId ?? undefined,
      threadId: body.threadId ?? undefined,
      visibility: body.visibility,
      sensitivityTier: body.sensitivityTier,
      importance: body.importance,
    })

    return reply.code(201).send(createApiResponse(result))
  })

  app.post('/api/thoughts/search', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    const body = parseInput(SearchThoughtsBodySchema, request.body, reply)
    if (!body) {
      return reply
    }

    try {
      const results = await thoughtService.search({
        query: body.query,
        organizationId: actorContext.tenant.organizationId,
        userId: actorContext.actor.actorId,
        threshold: body.threshold,
        limit: body.limit,
        includeReasoning: body.includeReasoning,
        mode: body.mode,
        sessionId: actorContext.actionContext.sessionId,
        channelId:
          actorContext.actionContext.channelId ?? actorContext.tenant.channelId,
      })
      return createApiResponse(results)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Search failed'
      return sendApiError(reply, 502, 'SEARCH_FAILED', msg)
    }
  })

  app.put('/api/thoughts/:id/outcome', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    const body = parseInput(RecordOutcomeBodySchema, request.body, reply)
    if (!body) {
      return reply
    }

    const { id } = request.params as { id: string }
    const orgId = actorContext.tenant.organizationId

    const hasAccess = await thoughtService.verifyAccess(id, orgId)
    if (!hasAccess) {
      return sendApiError(reply, 404, 'THOUGHT_NOT_FOUND', 'Thought not found')
    }

    await thoughtService.recordOutcome({
      thoughtId: id,
      outcome: body.outcome,
      outcomeNotes: body.outcomeNotes,
      actorType: actorContext.actor.actorType,
      actorId: actorContext.actor.actorId,
    })

    return createApiResponse({ ok: true })
  })

  app.put('/api/thoughts/recalls/:id/signal', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    const body = parseInput(RecordThoughtRecallSignalBodySchema, request.body, reply)
    if (!body) {
      return reply
    }

    const { id } = request.params as { id: string }
    const updated = await thoughtService.recordRecallSignal({
      recallId: id,
      organizationId: actorContext.tenant.organizationId,
      userSignal: body.userSignal,
    })

    if (!updated) {
      return sendApiError(reply, 404, 'THOUGHT_RECALL_NOT_FOUND', 'Thought recall not found')
    }

    return createApiResponse({ ok: true })
  })

  app.post('/api/thoughts/:id/link', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    const body = parseInput(LinkThoughtsBodySchema, request.body, reply)
    if (!body) {
      return reply
    }

    const { id } = request.params as { id: string }
    const orgId = actorContext.tenant.organizationId

    // Verify both source and target belong to caller's org
    const [sourceOk, targetOk] = await Promise.all([
      thoughtService.verifyAccess(id, orgId),
      thoughtService.verifyAccess(body.targetId, orgId),
    ])
    if (!sourceOk || !targetOk) {
      return sendApiError(reply, 404, 'THOUGHT_NOT_FOUND', 'Thought not found')
    }

    const linkId = await thoughtService.link({
      sourceId: id,
      targetId: body.targetId,
      relation: body.relation,
      metadata: body.metadata,
      actorType: actorContext.actor.actorType,
      actorId: actorContext.actor.actorId,
    })

    if (!linkId) {
      return createApiResponse({ linkId: null, alreadyExists: true })
    }

    return reply.code(201).send(createApiResponse({ linkId }))
  })

  app.get('/api/experience/stats', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    const actorId = (request.query as { actorId?: string }).actorId ?? null

    const stats = await thoughtService.experienceStats(
      actorContext.tenant.organizationId,
      actorId,
    )

    return createApiResponse(stats)
  })

  // ─── Designer chat ────────────────────────────────────────────────────────

  app.post('/api/designer/chat', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply

    const body = parseInput(DesignerChatBodySchema, request.body, reply)
    if (!body) return reply

    await streamDesignerChat(reply, body, config.model.apiKey)
    return reply
  })

  return app
}

export const startApiServer = async () => {
  const app = await buildApp()
  const initialBootstrapState = await resolveBootstrapState()
  if (initialBootstrapState) {
    logBootstrapUrl(initialBootstrapState)
  }

  await app.listen({
    host: config.api.host,
    port: config.api.port,
  })

  return app
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await startApiServer()
}
