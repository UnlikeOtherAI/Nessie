import type { FastifyInstance, FastifyReply } from 'fastify'

import {
  claimSessionControl,
  connectCloudBrowser,
  createBrowserbaseClient,
  disconnectCloudBrowser,
  isCloudBrowserError,
  listCloudBrowserConnections,
  releaseSessionControl,
  resetAgentBrowser,
} from '@nessie/browser-cloud'
import { createMcpSecretResolver, createPgSecretStore } from '@nessie/mcp-manage'

import {
  AgentBrowserResponseSchema,
  BrowserLoginListSchema,
  CloudBrowserConnectionListSchema,
  CloudBrowserSessionDetailSchema,
  CloudBrowserSessionListSchema,
  ConnectCloudBrowserBodySchema,
} from '../contracts/browser-cloud.js'
import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import { findThreadForUser } from '../services/message-read-state.js'
import type { RouteDeps } from './types.js'

/**
 * Cloud browser connections and the watch surface.
 *
 * Scope is decided by which route accepted the key — the owner gate on an
 * organization connect, the caller's own identity on a personal one — never
 * by anything about the key itself.
 */

const sendCloudBrowserError = (reply: FastifyReply, error: unknown): boolean => {
  if (!isCloudBrowserError(error)) return false
  const status =
    error.code === 'CLOUD_BROWSER_NO_CONNECTION' ? 404
    : error.code === 'CLOUD_BROWSER_AUTH_FAILED' ? 400
    : error.code === 'CLOUD_BROWSER_CAPACITY' ? 409
    : error.code === 'CLOUD_BROWSER_UNTRUSTED_ENDPOINT' ? 502
    : error.code === 'CLOUD_BROWSER_UNREACHABLE' ? 502
    : 400
  sendApiError(reply, status, error.code, error.message)
  return true
}


/**
 * One authorization rule for a session's live surface.
 *
 * A session on a browser somebody signed in renders only to the person who
 * asked for the run; an unauthenticated or ephemeral one renders to anyone
 * who can see the thread. An unauthorized session is shaped exactly like an
 * absent one.
 */
export interface ViewableCloudBrowserSession {
  id: string
  threadId: string
  agentId: string
  agentName: string
  runId: string
  status: string
  startedAt: Date
  endedAt: Date | null
  controlledByUserId: string | null
  browserbaseSessionId: string | null
  connectionProjectId: string
  connectionApiKeyRef: string
}

const loadViewableSession = async (
  prisma: RouteDeps['prisma'],
  input: {
    actorContext: { actor: { actorId: string }; tenant: { organizationId: string } }
    sessionId: string
    findThreadForUser: typeof findThreadForUser
  },
): Promise<ViewableCloudBrowserSession | null> => {
  const session = await prisma.cloudBrowserSession.findFirst({
    where: {
      id: input.sessionId,
      organizationId: input.actorContext.tenant.organizationId,
    },
    select: {
      id: true,
      threadId: true,
      agentBrowserId: true,
      authenticated: true,
      requestedByUserId: true,
      agentId: true,
      runId: true,
      status: true,
      startedAt: true,
      endedAt: true,
      controlledByUserId: true,
      browserbaseSessionId: true,
      agent: { select: { name: true } },
      connection: { select: { projectId: true, apiKeyRef: true } },
    },
  })
  if (!session) return null
  const thread = await input.findThreadForUser(
    prisma,
    session.threadId,
    input.actorContext.actor.actorId,
    input.actorContext.tenant.organizationId,
  )
  if (!thread) return null
  if (session.authenticated) {
    // The requester is not the only person with a claim here: somebody who
    // took the controls and signed in is looking at *their* logged-in page,
    // and narrowing to the requester alone would both hide it from them and
    // show it to somebody who never signed in.
    const viewer = input.actorContext.actor.actorId
    if (session.requestedByUserId !== viewer) {
      const signedIn = session.agentBrowserId
        ? await prisma.agentBrowserLogin.count({
          where: { agentBrowserId: session.agentBrowserId, userId: viewer },
        })
        : 0
      if (signedIn === 0) return null
    }
  }
  return {
    id: session.id,
    threadId: session.threadId,
    agentId: session.agentId,
    agentName: session.agent.name,
    runId: session.runId,
    status: session.status,
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    controlledByUserId: session.controlledByUserId,
    browserbaseSessionId: session.browserbaseSessionId,
    connectionProjectId: session.connection.projectId,
    connectionApiKeyRef: session.connection.apiKeyRef,
  }
}

export const registerBrowserCloudRoutes = (app: FastifyInstance, deps: RouteDeps): void => {
  const { prisma, authSecret, requireActorContext, requireOwner, requireUserActor } = deps

  // A dedicated prefix so a browser key is never confused with an MCP
  // credential, while reusing the one encrypted store both sides already use.
  const secretStore = createPgSecretStore(prisma, authSecret ?? '', {
    refPrefix: 'secret_browserbase_',
  })
  const secretResolver = createMcpSecretResolver(prisma, authSecret ?? '')

  const connectionDeps = {
    prisma,
    storeSecret: (apiKey: string) => secretStore.put({ accessToken: apiKey }),
  }

  app.get('/api/browser-cloud/connections', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply

    const connections = await listCloudBrowserConnections(prisma, {
      organizationId: actorContext.tenant.organizationId,
      userId: actorContext.actor.actorId,
    })
    return createApiResponse(
      CloudBrowserConnectionListSchema.parse({
        connections: connections.map((row) => ({
          id: row.id,
          scope: row.scope,
          projectId: row.projectId,
          status: row.status,
          healthReason: row.healthReason,
          healthDetail: row.healthDetail,
          createdAt: row.createdAt.toISOString(),
          liveSessions: row.liveSessions,
          usedMinutes: row.usedMinutes,
          isMine: row.scope === 'user' && row.userId === actorContext.actor.actorId,
        })),
      }),
    )
  })

  app.post('/api/browser-cloud/connections', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireUserActor(actorContext, reply)) return reply

    const body = parseInput(ConnectCloudBrowserBodySchema, request.body, reply)
    if (!body) return reply

    // The company and team subscriptions are owner decisions; a personal
    // account is anyone's own business and lands on their own row.
    if (body.scope !== 'user' && !requireOwner(actorContext, reply)) return reply

    if (body.scope === 'team') {
      if (!body.teamId) {
        sendApiError(reply, 400, 'VALIDATION_ERROR', 'A team account needs a team.')
        return reply
      }
      // Teams carry no organization_id of their own — tenancy runs through
      // their project — so the FK cannot make this check for us. The refusal
      // is indistinguishable from a team that does not exist.
      const team = await prisma.team.findFirst({
        where: {
          id: body.teamId,
          project: { organizationId: actorContext.tenant.organizationId },
        },
        select: { id: true },
      })
      if (!team) {
        sendApiError(reply, 404, 'NOT_FOUND', 'Team not found')
        return reply
      }
    }

    try {
      const result = await connectCloudBrowser(connectionDeps, {
        organizationId: actorContext.tenant.organizationId,
        scope: body.scope,
        teamId: body.scope === 'team' ? body.teamId ?? null : null,
        userId: body.scope === 'user' ? actorContext.actor.actorId : null,
        actingUserId: actorContext.actor.actorId,
        apiKey: body.apiKey,
        projectId: body.projectId,
      })
      return reply.code(201).send(createApiResponse({ id: result.id }))
    } catch (error) {
      if (sendCloudBrowserError(reply, error)) return reply
      throw error
    }
  })

  app.delete('/api/browser-cloud/connections/:connectionId', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply

    const { connectionId } = request.params as { connectionId: string }
    const row = await prisma.cloudBrowserConnection.findFirst({
      where: { id: connectionId, organizationId: actorContext.tenant.organizationId },
      select: { scope: true, userId: true },
    })
    if (!row) {
      sendApiError(reply, 404, 'CLOUD_BROWSER_NO_CONNECTION', 'That browser connection does not exist.')
      return reply
    }
    // Disconnecting a shared account is an owner act; a personal one is only
    // ever its own owner's.
    if (row.scope !== 'user') {
      if (!requireOwner(actorContext, reply)) return reply
    } else if (row.userId !== actorContext.actor.actorId) {
      sendApiError(reply, 404, 'CLOUD_BROWSER_NO_CONNECTION', 'That browser connection does not exist.')
      return reply
    }

    try {
      await disconnectCloudBrowser(prisma, {
        organizationId: actorContext.tenant.organizationId,
        connectionId,
      })
      return reply.code(204).send()
    } catch (error) {
      if (sendCloudBrowserError(reply, error)) return reply
      throw error
    }
  })

  app.get('/api/threads/:threadId/browser-sessions', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply

    const { threadId } = request.params as { threadId: string }
    const thread = await findThreadForUser(
      prisma,
      threadId,
      actorContext.actor.actorId,
      actorContext.tenant.organizationId,
    )
    if (!thread) {
      sendApiError(reply, 404, 'THREAD_NOT_FOUND', 'Thread not found')
      return reply
    }

    const { active } = request.query as { active?: string }
    const activeOnly = active === '1' || active === 'true'
    const sessions = await prisma.cloudBrowserSession.findMany({
      where: {
        threadId: thread.id,
        organizationId: actorContext.tenant.organizationId,
        ...(activeOnly ? { status: { in: ['allocating', 'active', 'releasing'] } } : {}),
        // A browser a person signed into is that person's; phase 1 opens none,
        // and this keeps the list honest the moment phase 2 does.
        OR: [
          { authenticated: false },
          { requestedByUserId: actorContext.actor.actorId },
        ],
      },
      select: {
        id: true,
        agentId: true,
        runId: true,
        status: true,
        startedAt: true,
        endedAt: true,
        controlledByUserId: true,
        agent: { select: { name: true } },
      },
      orderBy: { startedAt: 'desc' },
      take: 20,
    })

    return createApiResponse(
      CloudBrowserSessionListSchema.parse({
        sessions: sessions.map((row) => ({
          id: row.id,
          agentId: row.agentId,
          agentName: row.agent.name,
          runId: row.runId,
          status: row.status,
          startedAt: row.startedAt.toISOString(),
          endedAt: row.endedAt?.toISOString() ?? null,
          controlledByUserId: row.controlledByUserId,
        })),
      }),
    )
  })

  app.get('/api/browser-sessions/:sessionId', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply

    const { sessionId } = request.params as { sessionId: string }
    const session = await loadViewableSession(prisma, {
      actorContext,
      sessionId,
      findThreadForUser,
    })
    if (!session) {
      // An unauthorized session is shaped exactly like an absent one.
      sendApiError(reply, 404, 'CLOUD_BROWSER_SESSION_NOT_FOUND', 'Session not found')
      return reply
    }

    let liveViewUrl: string | null = null
    let tabs: Array<{ id: string; title: string; url: string; liveViewUrl: string }> = []
    const live = session.status === 'allocating' || session.status === 'active'
      || session.status === 'releasing'
    if (live && session.browserbaseSessionId) {
      const apiKey = await secretResolver.resolve(session.connectionApiKeyRef)
      if (apiKey) {
        try {
          const client = createBrowserbaseClient({
            apiKey,
            projectId: session.connectionProjectId,
          })
          const view = await client.liveView(session.browserbaseSessionId)
          liveViewUrl = view.debuggerFullscreenUrl
          tabs = view.pages.map((page) => ({
            id: page.id,
            title: page.title,
            url: page.url,
            liveViewUrl: page.debuggerFullscreenUrl,
          }))
        } catch {
          // A provider hiccup must not 500 the panel; the client renders the
          // session without a picture rather than an error page.
          liveViewUrl = null
        }
      }
    }

    return createApiResponse(
      CloudBrowserSessionDetailSchema.parse({
        id: session.id,
        agentId: session.agentId,
        agentName: session.agentName,
        runId: session.runId,
        status: session.status,
        startedAt: session.startedAt.toISOString(),
        endedAt: session.endedAt?.toISOString() ?? null,
        controlledByUserId: session.controlledByUserId,
        liveViewUrl,
        tabs,
      }),
    )
  })
  /**
   * An agent's browser: whether it exists, what it is signed in to, and who
   * signed it in. Readable by anyone entitled to see the agent, because that
   * audience is exactly who the logins are shared with.
   */
  app.get('/api/agents/:agentId/browser', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply

    const { agentId } = request.params as { agentId: string }
    const organizationId = actorContext.tenant.organizationId
    const visible = await deps.isAgentAccessibleToActor(actorContext, agentId)
    if (!visible) {
      sendApiError(reply, 404, 'AGENT_NOT_FOUND', 'Agent not found')
      return reply
    }

    const browser = await prisma.agentBrowser.findFirst({
      where: { organizationId, agentId, status: 'active' },
      select: {
        id: true,
        createdAt: true,
        lastUsedAt: true,
        connection: { select: { scope: true, projectId: true } },
        logins: {
          select: {
            id: true,
            serviceHint: true,
            createdAt: true,
            userId: true,
            member: { select: { user: { select: { displayName: true } } } },
          },
          orderBy: { createdAt: 'desc' },
        },
      },
    })
    if (!browser) {
      return createApiResponse(AgentBrowserResponseSchema.parse({ browser: null }))
    }
    const live = await prisma.cloudBrowserSession.count({
      where: {
        agentBrowserId: browser.id,
        status: { in: ['allocating', 'active', 'releasing'] },
      },
    })

    return createApiResponse(AgentBrowserResponseSchema.parse({
      browser: {
        id: browser.id,
        connectionScope: browser.connection.scope,
        createdAt: browser.createdAt.toISOString(),
        lastUsedAt: browser.lastUsedAt?.toISOString() ?? null,
        inUse: live > 0,
        logins: browser.logins.map((login) => ({
          id: login.id,
          serviceHint: login.serviceHint,
          createdAt: login.createdAt.toISOString(),
          signedInByUserId: login.userId,
          signedInByName: login.member?.user.displayName ?? null,
        })),
      },
    }))
  })

  /**
   * Sign the agent out of everything and start its browser over.
   *
   * Open to the agent's steward, an owner, or anyone who signed this browser
   * in — their own revocation right. Deliberately not every member: wiping a
   * team's logins would otherwise be a one-click denial of service.
   */
  app.post('/api/agents/:agentId/browser/reset', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireUserActor(actorContext, reply)) return reply

    const { agentId } = request.params as { agentId: string }
    const organizationId = actorContext.tenant.organizationId
    const userId = actorContext.actor.actorId

    const browser = await prisma.agentBrowser.findFirst({
      where: { organizationId, agentId, status: 'active' },
      select: {
        id: true,
        agent: { select: { ownerUserId: true } },
        logins: { select: { userId: true } },
      },
    })
    if (!browser) {
      sendApiError(reply, 404, 'CLOUD_BROWSER_NO_BROWSER', 'This agent has no browser.')
      return reply
    }

    const isOwner = actorContext.actor.roles?.includes('owner') ?? false
    const isSteward = browser.agent.ownerUserId === userId
    const isSigner = browser.logins.some((login) => login.userId === userId)
    if (!isOwner && !isSteward && !isSigner) {
      sendApiError(
        reply,
        403,
        'FORBIDDEN',
        'Only this agent’s owner, a team owner, or somebody who signed it in can reset its browser.',
      )
      return reply
    }

    try {
      await resetAgentBrowser(prisma, { agentBrowserId: browser.id, organizationId })
      return reply.code(204).send()
    } catch (error) {
      if (sendCloudBrowserError(reply, error)) return reply
      throw error
    }
  })

  /**
   * Every sign-in this person performed, across agents — so revoking "I signed
   * that agent into my Google" never means hunting through agents.
   */
  app.get('/api/browser-cloud/my-logins', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply

    const logins = await prisma.agentBrowserLogin.findMany({
      where: {
        organizationId: actorContext.tenant.organizationId,
        userId: actorContext.actor.actorId,
        agentBrowser: { status: 'active' },
      },
      select: {
        id: true,
        serviceHint: true,
        createdAt: true,
        agentBrowser: { select: { agentId: true, agent: { select: { name: true } } } },
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    })

    return createApiResponse(BrowserLoginListSchema.parse({
      logins: logins.map((login) => ({
        id: login.id,
        agentId: login.agentBrowser.agentId,
        agentName: login.agentBrowser.agent.name,
        serviceHint: login.serviceHint,
        createdAt: login.createdAt.toISOString(),
      })),
    }))
  })
  /**
   * Take the controls, or renew a claim the viewer is still holding.
   *
   * The claim is coordination and audit, not the security boundary — that is
   * who may fetch the live-view URL at all, and everyone it admits could
   * already drive. What the claim does guarantee is that the *agent* stands
   * down: every browser verb is refused while it is held.
   */
  app.post('/api/browser-sessions/:sessionId/control', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireUserActor(actorContext, reply)) return reply

    const { sessionId } = request.params as { sessionId: string }
    const session = await loadViewableSession(prisma, {
      actorContext,
      sessionId,
      findThreadForUser,
    })
    if (!session) {
      sendApiError(reply, 404, 'CLOUD_BROWSER_SESSION_NOT_FOUND', 'Session not found')
      return reply
    }

    const claimed = await claimSessionControl(prisma, {
      sessionId,
      userId: actorContext.actor.actorId,
    })
    if (!claimed) {
      sendApiError(
        reply,
        409,
        'CLOUD_BROWSER_CONTROL_HELD',
        'Somebody else is at the controls of this browser.',
      )
      return reply
    }
    return createApiResponse({ controlling: true })
  })

  app.delete('/api/browser-sessions/:sessionId/control', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireUserActor(actorContext, reply)) return reply

    const { sessionId } = request.params as { sessionId: string }
    // Only the holder may hand back, so a bystander cannot yank the controls
    // out from under somebody mid-sign-in.
    await releaseSessionControl(prisma, {
      sessionId,
      userId: actorContext.actor.actorId,
    })
    return reply.code(204).send()
  })
}


