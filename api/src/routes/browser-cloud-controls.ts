import type { FastifyInstance } from 'fastify'
import type { CredentialStore } from '@nessie/dashboard'

import {
  captureUndrivenSessionTabs,
  claimSessionControl,
  CONTROL_CLAIM_TTL_MS,
  releaseSessionControl,
  touchResumedSession,
  viewerMaySeeAgentBrowser,
} from '@nessie/browser-cloud'

import {
  AgentBrowserViewportResponseSchema,
  CloudBrowserSessionViewportResponseSchema,
  BrowserHomeResponseSchema,
  BrowserSessionContinueResponseSchema,
  SetAgentBrowserViewportBodySchema,
  SetCloudBrowserSessionViewportBodySchema,
} from '../contracts/browser-cloud.js'
import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import {
  agentHasBrowserOpenGrant,
  agentInThread,
  browserScopeFor,
  loadViewableSession,
} from './browser-cloud-access.js'
import type { BrowserSessionOperations } from './browser-cloud-session-operations.js'
import type { RouteDeps } from './types.js'

export const registerBrowserCloudControlRoutes = (
  app: FastifyInstance,
  input: {
    deps: RouteDeps & { dashboardCredentials: CredentialStore }
    operations: BrowserSessionOperations
  },
): void => {
  const { deps, operations } = input
  const { prisma, authSecret, requireActorContext, requireUserActor } = deps

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
  const session = await loadViewableSession(prisma, { actorContext, sessionId })
  if (!session) {
    sendApiError(reply, 404, 'CLOUD_BROWSER_SESSION_NOT_FOUND', 'Session not found')
    return reply
  }
  if (!session.canControl) {
    sendApiError(reply, 404, 'CLOUD_BROWSER_SESSION_NOT_FOUND', 'Session not found')
    return reply
  }
  if (!(await agentHasBrowserOpenGrant(prisma, {
    agentId: session.agentId,
    organizationId: actorContext.tenant.organizationId,
  }))) {
    sendApiError(reply, 404, 'CLOUD_BROWSER_SESSION_NOT_FOUND', 'Session not found')
    return reply
  }
  // An ephemeral session has no durable browser audience. Its requester is
  // the sole person allowed to take the controls before a sign-in makes the
  // live view sensitive; otherwise a channel member could claim it while it
  // was still unauthenticated and inherit the resulting login.
  if (
    session.agentBrowserId === null
    && session.requestedByUserId !== actorContext.actor.actorId
  ) {
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
  if (session.runId === null && !session.personalAccess) {
    await touchResumedSession(prisma, { sessionId: session.id })
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
  const released = await releaseSessionControl(prisma, {
    sessionId,
    userId: actorContext.actor.actorId,
  })
  // Handing back is "I'm done" on a resumed session — the person signed in
  // somewhere, or moved the browser on — so the last state is written now
  // rather than minutes later when the idle window closes it. A run's
  // session is left alone: its worker holds the socket and captures itself.
  const resumed = released
    ? await prisma.cloudBrowserSession.findFirst({
      where: {
        id: sessionId,
        organizationId: actorContext.tenant.organizationId,
        runId: null,
        status: 'active',
        agentBrowserId: { not: null },
      },
      select: { id: true },
    })
    : null
  if (resumed) {
    await captureUndrivenSessionTabs(prisma, {
      sessionId,
      encryptionSecret: authSecret ?? '',
    })
  }
  return reply.code(204).send()
})

/** Resize the one-time private session without changing an agent's durable jar. */
app.post('/api/browser-sessions/:sessionId/viewport', async (request, reply) => {
  const actorContext = requireActorContext(request, reply)
  if (!actorContext) return reply
  if (!requireUserActor(actorContext, reply)) return reply
  const viewport = parseInput(SetCloudBrowserSessionViewportBodySchema, request.body, reply)
  if (!viewport) return reply

  const { sessionId } = request.params as { sessionId: string }
  const session = await loadViewableSession(prisma, { actorContext, sessionId })
  if (!session || !session.personalAccess || !session.canControl || !session.controlLeaseActive
    || session.viewerMode !== 'controller') {
    sendApiError(reply, 404, 'CLOUD_BROWSER_SESSION_NOT_FOUND', 'Session not found')
    return reply
  }
  const changed = await prisma.cloudBrowserSession.updateMany({
    where: {
      id: session.id,
      status: 'active',
      expiresAt: { gt: new Date() },
      controlledByUserId: actorContext.actor.actorId,
      controlClaimedAt: { gt: new Date(Date.now() - CONTROL_CLAIM_TTL_MS) },
    },
    data: { viewportHeight: viewport.height, viewportWidth: viewport.width },
  })
  if (changed.count !== 1) {
    sendApiError(reply, 409, 'CLOUD_BROWSER_CONTROL_HELD', 'Take control to change this browser size.')
    return reply
  }
  return createApiResponse(CloudBrowserSessionViewportResponseSchema.parse({ viewport }))
})

/**
 * The window the agent's browser opens in.
 *
 * Stored on the browser rather than on the person or the conversation,
 * because it is a property of the *work*: an agent that reads a dashboard
 * needs a wide page every time it opens one, whoever asked. That also makes
 * it per-person exactly where the browser already is — a system-managed
 * agent's browser is one row per principal, so sizing the Personal
 * Assistant's window sizes yours and nobody else's.
 *
 * Browserbase fixes a viewport when the session is created, so the stored
 * pair governs the next open. A session already on screen is resized too,
 * best effort: the override is a page-level one, and a provider that refuses
 * it must not lose the reader their setting.
 */
app.post('/api/threads/:threadId/agents/:agentId/browser/viewport', async (request, reply) => {
  const actorContext = requireActorContext(request, reply)
  if (!actorContext) return reply
  if (!requireUserActor(actorContext, reply)) return reply

  const { threadId, agentId } = request.params as { threadId: string; agentId: string }
  const organizationId = actorContext.tenant.organizationId
  const viewport = parseInput(SetAgentBrowserViewportBodySchema, request.body, reply)
  if (!viewport) return reply

  const reach = await agentInThread(prisma, {
    organizationId,
    threadId,
    agentId,
    userId: actorContext.actor.actorId,
  })
  if (!reach || !(await agentHasBrowserOpenGrant(prisma, { agentId, organizationId }))) {
    sendApiError(reply, 404, 'AGENT_NOT_FOUND', 'Agent not found')
    return reply
  }
  // The same scoping the tabs and the resume use, so a person can only size
  // the browser they can already open.
  const scope = await browserScopeFor(prisma, {
    organizationId,
    agentId,
    viewerId: actorContext.actor.actorId,
  })
  const browser = scope && await prisma.agentBrowser.findFirst({
    where: { organizationId, agentId, status: 'active', ...scope },
    select: { id: true },
  })
  if (!browser) {
    sendApiError(
      reply,
      404,
      'CLOUD_BROWSER_NO_BROWSER',
      'This agent has no browser yet. Open one, then set its size.',
    )
    return reply
  }
  // A browser somebody signed into shows that person's pages at whatever
  // size it is set to, so changing it takes the audience that watching does.
  const allowed = await viewerMaySeeAgentBrowser(prisma, {
    agentBrowserId: browser.id,
    viewerId: actorContext.actor.actorId,
  })
  if (!allowed) {
    sendApiError(
      reply,
      403,
      'AGENT_BROWSER_SIGNED_IN_BY_OTHERS',
      'This browser is signed in by someone else, so only they can change it.',
    )
    return reply
  }

  await prisma.agentBrowser.update({
    data: { viewportHeight: viewport.height, viewportWidth: viewport.width },
    where: { id: browser.id },
  })

  // Only a session this person is driving is resized under them. Reflowing
  // a page an agent is working on mid-run would move every element it had
  // just located, which is a far worse thing to do than let the new size
  // wait for the next open — and the row is already written either way.
  const live = await prisma.cloudBrowserSession.findFirst({
    where: {
      organizationId,
      agentBrowserId: browser.id,
      status: 'active',
      controlledByUserId: actorContext.actor.actorId,
    },
    select: { id: true },
  })
  const appliedToLiveSession = live
    ? await operations.resize({ sessionId: live.id, viewport })
    : false

  return createApiResponse(
    AgentBrowserViewportResponseSchema.parse({ appliedToLiveSession, viewport }),
  )
})

/**
 * "I am still here."
 *
 * The one thing that extends a resumed session's idle window. It used to be
 * the column's own poll, which meant a browser left open renewed itself with
 * nobody in front of it — a person who walked away from an open session kept
 * a cloud browser billing until the hard TTL. The countdown in the panel asks
 * for this press a minute before the window closes; no press, and the reaper
 * takes it.
 *
 * Watching is enough to press it: presence is the point, and somebody who
 * can see the session is somebody who is there. `touchResumedSession` is
 * capped at `startedAt + ttlMs`, so pressing it forever cannot outlive the
 * hard limit.
 */
app.post('/api/browser-sessions/:sessionId/continue', async (request, reply) => {
  const actorContext = requireActorContext(request, reply)
  if (!actorContext) return reply
  if (!requireUserActor(actorContext, reply)) return reply

  const { sessionId } = request.params as { sessionId: string }
  const session = await loadViewableSession(prisma, { actorContext, sessionId })
  if (!session) {
    sendApiError(reply, 404, 'CLOUD_BROWSER_SESSION_NOT_FOUND', 'Session not found')
    return reply
  }
  if (!(await agentHasBrowserOpenGrant(prisma, {
    agentId: session.agentId,
    organizationId: actorContext.tenant.organizationId,
  }))) {
    sendApiError(reply, 404, 'CLOUD_BROWSER_SESSION_NOT_FOUND', 'Session not found')
    return reply
  }
  // `touchResumedSession` extends only a live session with no run, so a
  // press against a released one, or against a session an agent has since
  // adopted, changes nothing. Answering 200 with the row's unchanged expiry
  // is honest: the countdown reads it, sees no time was added, and stops
  // claiming otherwise.
  await touchResumedSession(prisma, { sessionId: session.id })
  // Read back rather than compute: the cap may have clamped the extension,
  // and the countdown must agree with the reaper, not with this route's
  // arithmetic.
  const extended = await prisma.cloudBrowserSession.findUnique({
    select: { expiresAt: true },
    where: { id: session.id },
  })
  return createApiResponse(BrowserSessionContinueResponseSchema.parse({
    expiresAt: (extended?.expiresAt ?? session.expiresAt).toISOString(),
  }))
})

/**
 * Send a browser home.
 *
 * The address is resolved through the ordinary settings cascade — the
 * organisation's, then the team's, then the person's — so an install that
 * starts everywhere but Google says so once, at the level it means. Anything
 * unusable falls back to the default rather than failing the press, because
 * a home button that reports a configuration error is a home button nobody
 * presses again.
 *
 * Only the driver may steer. Navigating a browser somebody else is typing
 * into is the same interruption as taking the keyboard off them, and the
 * claim is what that decision already lives in.
 */
app.post('/api/browser-sessions/:sessionId/home', async (request, reply) => {
  const actorContext = requireActorContext(request, reply)
  if (!actorContext) return reply
  if (!requireUserActor(actorContext, reply)) return reply

  const { sessionId } = request.params as { sessionId: string }
  const session = await loadViewableSession(prisma, { actorContext, sessionId })
  if (!session) {
    sendApiError(reply, 404, 'CLOUD_BROWSER_SESSION_NOT_FOUND', 'Session not found')
    return reply
  }
  if (!(await agentHasBrowserOpenGrant(prisma, {
    agentId: session.agentId,
    organizationId: actorContext.tenant.organizationId,
  }))) {
    sendApiError(reply, 404, 'CLOUD_BROWSER_SESSION_NOT_FOUND', 'Session not found')
    return reply
  }
  if (session.viewerMode !== 'controller') {
    sendApiError(
      reply,
      409,
      'CLOUD_BROWSER_NOT_DRIVING',
      'Take control of the browser before sending it home.',
    )
    return reply
  }

  const url = await operations.homepageFor({
    organizationId: actorContext.tenant.organizationId,
    threadId: session.threadId,
    userId: actorContext.actor.actorId,
  })
  const sent = await operations.navigate({ sessionId: session.id, url })
  if (!sent) {
    sendApiError(
      reply,
      502,
      'CLOUD_BROWSER_UNREACHABLE',
      'The browser did not answer. Try again in a moment.',
    )
    return reply
  }
  if (session.runId === null && !session.personalAccess) {
    await touchResumedSession(prisma, { sessionId: session.id })
  }
  return createApiResponse(BrowserHomeResponseSchema.parse({ url }))
})
}
