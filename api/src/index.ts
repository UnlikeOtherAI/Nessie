import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import cors from '@fastify/cors'
import websocket from '@fastify/websocket'
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify'
import { loadConfig } from '@nessie/config'
import {
  MeResponseSchema,
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
  AgentRecordSchema,
  AuthProviderDescriptorSchema,
  BootstrapModeResponseSchema,
  BootstrapRequestSchema,
  ChannelRecordSchema,
  CreateAgentBindingBodySchema,
  CreateAgentBodySchema,
  CreateChannelBodySchema,
  CreateThreadMessageBodySchema,
  LoginRequestSchema,
  ThreadMessageRecordSchema,
  ToolDescriptorSchema,
} from './contracts.js'
import { getPrismaClient } from './db/client.js'
import { seedBootstrapRecords } from './db/seed.js'
import { createApiResponse, parseInput, sendApiError } from './lib/api.js'
import { enqueueRunExecution } from './queue/pgqueue.js'
import { createRealtimeHub } from './realtime/hub.js'
import {
  bindAgentToChannel,
  buildSnapshotForScopes,
  createAgentRecord,
  listAgentsForUser,
  loadAgentActivity,
  loadAgentChildren,
  loadAgentMessages,
  loadAgentStatus,
  loadRunToolCalls,
} from './services/agents.js'
import {
  LOCAL_AUTH_PROVIDER_ID,
  buildMeResponse,
  createActorContextFromClaims,
  listAuthProviders,
} from './services/auth.js'
import { createChannelForUser, listChannelsForUser } from './services/channels.js'
import {
  createThreadMessage,
  findThreadForUser,
  listThreadMessages,
} from './services/messages.js'
import { listSafeTools } from './services/tools.js'

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
  if (!header) {
    return null
  }

  const [scheme, token] = header.split(' ')
  if (scheme !== 'Bearer' || !token) {
    return null
  }

  return token
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

export const buildApp = async () => {
  const app = Fastify({ logger: true })
  const realtimeHub = await createRealtimeHub({
    databaseUrl,
    poolMax: config.database.poolMax,
    poolMin: config.database.poolMin,
  })

  await app.register(cors, { origin: true, credentials: true })
  await app.register(websocket)

  app.decorateRequest('actorContext', null)

  app.addHook('onClose', async () => {
    await realtimeHub.close()
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
      sendApiError(
        reply,
        501,
        'SSO_NOT_IMPLEMENTED',
        'External provider session exchange is not implemented yet',
        'providerId',
      )
      return reply
    }

    if (!body.password) {
      sendApiError(reply, 400, 'PASSWORD_REQUIRED', 'Password is required', 'password')
      return reply
    }

    const user = await prisma.user.findUnique({
      where: { email: body.email.toLowerCase() },
      include: {
        organizationMembers: {
          orderBy: { createdAt: 'asc' },
          take: 1,
          select: { role: true },
        },
      },
    })

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
      name: body.name,
      role: body.role ?? 'assistant',
      systemPrompt: body.systemPrompt,
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

  app.get('/api/tools', async () =>
    createApiResponse(ToolDescriptorSchema.array().parse(listSafeTools())),
  )

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
