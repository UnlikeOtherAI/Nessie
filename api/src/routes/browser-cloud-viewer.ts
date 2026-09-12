import type { FastifyInstance } from 'fastify'
import { CloudBrowserSessionDetailSchema, CloudBrowserSessionListSchema, CloudBrowserSessionScreenshotSchema } from '../contracts/browser-cloud.js'
import { createApiResponse, sendApiError } from '../lib/api.js'
import { findThreadForUser } from '../services/message-read-state.js'
import { agentHasBrowserOpenGrant, loadViewableSession } from './browser-cloud-access.js'
import { captureLiveBrowserScreenshot } from './browser-cloud-live-session.js'
import type { RouteDeps } from './types.js'

type BrowserCloudViewerRouteDeps = RouteDeps & {
  /** Route-local seams keep the authorization races testable without provider I/O. */
  browserViewerOperations?: {
    agentHasBrowserOpenGrant?: typeof agentHasBrowserOpenGrant
    captureLiveBrowserScreenshot?: typeof captureLiveBrowserScreenshot
    loadViewableSession?: typeof loadViewableSession
  }
}

export const registerBrowserCloudViewerRoutes = (
  app: FastifyInstance,
  deps: BrowserCloudViewerRouteDeps,
): void => {
  const { authSecret, prisma, requireActorContext } = deps
  const hasBrowserOpenGrant = deps.browserViewerOperations?.agentHasBrowserOpenGrant
    ?? agentHasBrowserOpenGrant
  const captureScreenshot = deps.browserViewerOperations?.captureLiveBrowserScreenshot
    ?? captureLiveBrowserScreenshot
  const loadSession = deps.browserViewerOperations?.loadViewableSession ?? loadViewableSession
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
    const candidates = await prisma.cloudBrowserSession.findMany({
      where: {
        threadId: thread.id,
        organizationId: actorContext.tenant.organizationId,
        interactionTransport: 'mediated',
        ...(activeOnly ? { status: { in: ['allocating', 'active', 'releasing'] } } : {}),
      },
      select: { id: true },
      orderBy: { startedAt: 'desc' },
      take: 20,
    })
    // The list is a doorway, so it uses the same fresh audience predicate as
    // detail, screenshot, canvas, and input. A requester field is billing
    // provenance; it is never an authorization shortcut.
    const visible = (await Promise.all(candidates.map(({ id }) =>
      loadSession(prisma, { actorContext, sessionId: id }),
    ))).filter((session): session is NonNullable<typeof session> => session !== null)
    return createApiResponse(CloudBrowserSessionListSchema.parse({
      sessions: visible.map((session) => ({
        id: session.id,
        agentId: session.agentId,
        agentName: session.agentName,
        runId: session.runId,
        status: session.status,
        startedAt: session.startedAt.toISOString(),
        endedAt: session.endedAt?.toISOString() ?? null,
        controlledByUserId: session.controlledByUserId,
      })),
    }))
  })

  app.get('/api/browser-sessions/:sessionId', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply

    const { sessionId } = request.params as { sessionId: string }
    const session = await loadSession(prisma, { actorContext, sessionId })
    if (!session) {
      // An unauthorized session is shaped exactly like an absent one.
      sendApiError(reply, 404, 'CLOUD_BROWSER_SESSION_NOT_FOUND', 'Session not found')
      return reply
    }
    if (!(await hasBrowserOpenGrant(prisma, {
      agentId: session.agentId,
      organizationId: actorContext.tenant.organizationId,
    }))) {
      sendApiError(reply, 404, 'CLOUD_BROWSER_SESSION_NOT_FOUND', 'Session not found')
      return reply
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
        controlLeaseActive: session.controlLeaseActive,
        canControl: session.canControl,
        viewerMode: session.viewerMode,
        shared: session.shared,
        viewport: session.viewport,
        expiresAt: session.expiresAt.toISOString(),
        liveViewUrl: null,
        privateAccess: session.personalAccess && session.personalAccessGrantId
          ? { grantId: session.personalAccessGrantId, expiresAt: session.expiresAt.toISOString() }
          : null,
        tabs: [],
      }),
    )
  })

  /**
   * A private frame for the remote canvas. The Browserbase URL and CDP connect
   * capability stay server-side; this response is deliberately never cached
   * or persisted, especially for a personal browser session.
   */
  app.get('/api/browser-sessions/:sessionId/screenshot', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    const { sessionId } = request.params as { sessionId: string }
    const session = await loadSession(prisma, { actorContext, sessionId })
    if (!session) {
      sendApiError(reply, 404, 'CLOUD_BROWSER_SESSION_NOT_FOUND', 'Session not found')
      return reply
    }
    if (!(await hasBrowserOpenGrant(prisma, {
      agentId: session.agentId, organizationId: actorContext.tenant.organizationId,
    }))) {
      sendApiError(reply, 404, 'CLOUD_BROWSER_SESSION_NOT_FOUND', 'Session not found')
      return reply
    }
    const live = session.status === 'allocating' || session.status === 'active'
    const imageDataUrl = live && session.browserbaseSessionId
      ? await captureScreenshot(prisma, {
        encryptionSecret: encryptionKeyRing, sessionId: session.id,
      })
      : null
    // CDP capture can take seconds. Do not return a frame captured under an
    // audience that changed while it was in flight (for example, a new human
    // controller taking a formerly observable unattended session).
    // A normal HTTP request is authenticated only once by the global hook.
    // Capture can take seconds, so verify the exact bearer again before a
    // private frame leaves this process; a sign-out or token revocation must
    // make the in-flight response disappear just as it does on the canvas.
    const refreshed = await deps.authenticateRequest(request, null)
    if (!refreshed) {
      sendApiError(reply, 404, 'CLOUD_BROWSER_SESSION_NOT_FOUND', 'Session not found')
      return reply
    }
    const stillViewable = await loadSession(prisma, {
      actorContext: refreshed.actorContext,
      sessionId,
    })
    if (!stillViewable || !(await hasBrowserOpenGrant(prisma, {
      agentId: stillViewable.agentId,
      organizationId: refreshed.actorContext.tenant.organizationId,
    }))) {
      sendApiError(reply, 404, 'CLOUD_BROWSER_SESSION_NOT_FOUND', 'Session not found')
      return reply
    }
    reply.header('Cache-Control', 'private, no-store')
    return createApiResponse(CloudBrowserSessionScreenshotSchema.parse({ imageDataUrl }))
  })


}
