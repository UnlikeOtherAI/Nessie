import type { FastifyInstance, FastifyReply } from 'fastify'

import {
  connectCloudBrowser,
  createBrowserbaseClient,
  disconnectCloudBrowser,
  isCloudBrowserError,
  listCloudBrowserConnections,
} from '@nessie/browser-cloud'
import { createMcpSecretResolver, createPgSecretStore } from '@nessie/mcp-manage'

import {
  CloudBrowserConnectionListSchema,
  CloudBrowserSessionDetailSchema,
  CloudBrowserSessionListSchema,
  ConnectCloudBrowserBodySchema,
} from '../contracts/browser-cloud.js'
import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import { findThreadForUser } from '../services/messages.js'
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

    // The company subscription is an owner decision; a personal account is
    // anyone's own business and lands on their own row.
    if (body.scope === 'organization' && !requireOwner(actorContext, reply)) return reply

    try {
      const result = await connectCloudBrowser(connectionDeps, {
        organizationId: actorContext.tenant.organizationId,
        scope: body.scope,
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
    // Disconnecting the company account is an owner act; a personal one is
    // only ever its own owner's.
    if (row.scope === 'organization') {
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
    // Session ids are global uuids, so organization is re-checked here and not
    // inferred from the thread gate alone — the document-stream rule verbatim.
    const session = await prisma.cloudBrowserSession.findFirst({
      where: { id: sessionId, organizationId: actorContext.tenant.organizationId },
      select: {
        id: true,
        agentId: true,
        runId: true,
        threadId: true,
        status: true,
        startedAt: true,
        endedAt: true,
        authenticated: true,
        requestedByUserId: true,
        controlledByUserId: true,
        browserbaseSessionId: true,
        agent: { select: { name: true } },
        connection: { select: { projectId: true, apiKeyRef: true } },
      },
    })

    const notFound = (): FastifyReply => {
      // An unauthorized session is shaped exactly like an absent one.
      sendApiError(reply, 404, 'CLOUD_BROWSER_SESSION_NOT_FOUND', 'Session not found')
      return reply
    }
    if (!session) return notFound()

    const thread = await findThreadForUser(
      prisma,
      session.threadId,
      actorContext.actor.actorId,
      actorContext.tenant.organizationId,
    )
    if (!thread) return notFound()
    if (session.authenticated && session.requestedByUserId !== actorContext.actor.actorId) {
      return notFound()
    }

    let liveViewUrl: string | null = null
    let tabs: Array<{ id: string; title: string; url: string; liveViewUrl: string }> = []
    const live = session.status === 'allocating' || session.status === 'active'
      || session.status === 'releasing'
    if (live && session.browserbaseSessionId) {
      const apiKey = await secretResolver.resolve(session.connection.apiKeyRef)
      if (apiKey) {
        try {
          const client = createBrowserbaseClient({
            apiKey,
            projectId: session.connection.projectId,
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
        agentName: session.agent.name,
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
}
