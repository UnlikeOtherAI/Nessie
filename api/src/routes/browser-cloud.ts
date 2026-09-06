import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'

import {
  claimSessionControl,
  connectCdp,
  connectCloudBrowser,
  createBrowserbaseClient,
  disconnectCloudBrowser,
  isCloudBrowserError,
  captureUndrivenSessionTabs,
  listAgentBrowserTabs,
  listCloudBrowserConnections,
  loadSessionCapability,
  releaseSessionControl,
  resetAgentBrowser,
  resumeAgentBrowser,
  touchResumedSession,
  viewerMaySeeAgentBrowser,
  type CdpClient,
} from '@nessie/browser-cloud'
import {
  BROWSER_HOMEPAGE_SETTING_KEY,
  browserViewportOrDefault,
  resolveBrowserHomepage,
  type BrowserViewport,
} from '@nessie/schemas'
import { createMcpSecretResolver, createPgSecretStore } from '@nessie/mcp-manage'
import { resolveScopedSetting } from '@nessie/runtime'

import {
  AgentBrowserResponseSchema,
  AgentBrowserTabsResponseSchema,
  BrowserLoginListSchema,
  CloudBrowserConnectionListSchema,
  CloudBrowserSessionDetailSchema,
  CloudBrowserSessionListSchema,
  ConnectCloudBrowserBodySchema,
  ResumeAgentBrowserResponseSchema,
  AgentBrowserViewportResponseSchema,
  BrowserHomeResponseSchema,
  BrowserSessionContinueResponseSchema,
  SetAgentBrowserViewportBodySchema,
} from '../contracts/browser-cloud.js'
import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import { nudgeAgentAfterHandover } from '../services/browser-handover.js'
import { findThreadForUser } from '../services/message-read-state.js'
import type { RouteDeps } from './types.js'

/**
 * Cloud browser connections and the watch surface.
 *
 * Scope is decided by which route accepted the key — the owner gate on an
 * organization connect, the caller's own identity on a personal one — never
 * by anything about the key itself.
 */

/**
 * Which browser row belongs to this caller, for this agent.
 *
 * A system-managed agent keeps one browser per person, so the caller's own is
 * the only one they may ever reach; an ordinary agent has one shared with its
 * team, where the principal is null. Every read of an agent's browser goes
 * through this, so no route can accidentally hand somebody a colleague's jar.
 */
const browserScopeFor = async (
  prisma: RouteDeps['prisma'],
  input: { organizationId: string; agentId: string; viewerId: string },
): Promise<{ principalUserId: string | null } | null> => {
  const agent = await prisma.agent.findFirst({
    where: { id: input.agentId, organizationId: input.organizationId },
    select: { systemManaged: true },
  })
  if (!agent) return null
  return { principalUserId: agent.systemManaged ? input.viewerId : null }
}

/**
 * Whether signing in through a session signs in for other people too.
 *
 * The sentence the viewer shows above a sign-in box is this answer, so it has
 * one home. Three ways it is false: the session keeps nothing (no durable
 * browser behind it), the jar belongs to one person (a system-managed agent's,
 * since browsers became per-principal), or only the owner can reach the agent.
 * It used to be read off the agent's visibility alone, which said "shared" for
 * the Personal Assistant — an agent everyone meets, whose browser nobody
 * shares.
 */
export const browserSessionIsShared = (input: {
  /** Null when the browser is one jar for everyone; absent when there is none. */
  principalUserId?: string | null
  agentVisibility: string
}): boolean =>
  input.principalUserId === null && input.agentVisibility !== 'private'

/** The site a URL is on, for a reader who may know where but not what. */
const originOf = (url: string): string => {
  try {
    return new URL(url).origin
  } catch {
    return ''
  }
}

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
  runId: string | null
  status: string
  startedAt: Date
  endedAt: Date | null
  controlledByUserId: string | null
  browserbaseSessionId: string | null
  /**
   * When the idle window closes. The client counts down against this rather
   * than against a timer of its own, so a reload cannot silently restart it
   * and show time remaining on a session the reaper has already taken.
   */
  expiresAt: Date
  /** The durable browser this session rides on, when it has one. */
  agentBrowserId: string | null
  connectionProjectId: string | null
  connectionApiKeyRef: string
  /**
   * Whether signing in here is signing in for other people too. A durable
   * browser with a principal belongs to that one person, so it is not shared
   * however visible the agent is; a throwaway session persists nothing.
   */
  shared: boolean
  /**
   * The window the browser opens in, defaulted here so no reader has to know
   * that "never sized" is stored as a null pair.
   */
  viewport: BrowserViewport
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
      expiresAt: true,
      agent: { select: { name: true, visibility: true } },
      agentBrowser: {
        select: { principalUserId: true, viewportHeight: true, viewportWidth: true },
      },
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
  if (session.authenticated && session.agentBrowserId) {
    // One audience rule for everything a signed-in browser shows — the live
    // view here, the stored tabs, and the resume — in `viewerMaySeeAgentBrowser`.
    const allowed = await viewerMaySeeAgentBrowser(prisma, {
      agentBrowserId: session.agentBrowserId,
      viewerId: input.actorContext.actor.actorId,
      requestedByUserId: session.requestedByUserId,
    })
    if (!allowed) return null
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
    expiresAt: session.expiresAt,
    connectionProjectId: session.connection.projectId,
    agentBrowserId: session.agentBrowserId,
    connectionApiKeyRef: session.connection.apiKeyRef,
    shared: browserSessionIsShared({
      agentVisibility: session.agent.visibility,
      principalUserId: session.agentBrowser?.principalUserId,
    }),
    viewport: browserViewportOrDefault(
      session.agentBrowser
        ? { height: session.agentBrowser.viewportHeight, width: session.agentBrowser.viewportWidth }
        : null,
    ),
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
        // A browser a person signed into is that person's. This is the list's
        // cut of the audience rule in `viewerMaySeeAgentBrowser`: the requester
        // always, and otherwise only sessions nobody has signed in — signers
        // who did not ask reach theirs through the detail read.
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
    // Reading no longer extends. The column polls this route by itself every
    // fifteen seconds, so treating a read as presence meant a browser left
    // open on a second monitor renewed its own idle window until the hard TTL
    // — a person who walked away kept billing. Presence is now an explicit
    // press (`POST .../continue`), which is what the countdown asks for.
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
        shared: session.shared,
        viewport: session.viewport,
        expiresAt: session.expiresAt.toISOString(),
        liveViewUrl,
        tabs,
      }),
    )
  })
  /**
   * Whether this agent is reachable from this thread by this person.
   *
   * Thread-scoped on purpose, like the session routes: `isAgentAccessibleToActor`
   * refuses every system-managed agent, and the Personal Assistant's own DM is
   * the most-visited conversation there is. An agent is in a conversation when
   * it is bound to the channel — for the PA, bound with this person as its
   * principal.
   */
  const agentInThread = async (input: {
    organizationId: string
    threadId: string
    agentId: string
    userId: string
  }): Promise<{ channelId: string; teamId: string | null } | null> => {
    // Path ids reach Prisma as uuid columns, and a malformed one throws there
    // rather than matching nothing — which a client would see as a 500 for
    // what is simply an address that names nothing.
    if (!z.string().uuid().safeParse(input.threadId).success
      || !z.string().uuid().safeParse(input.agentId).success) {
      return null
    }
    const thread = await findThreadForUser(prisma, input.threadId, input.userId, input.organizationId)
    if (!thread) return null
    const bound = await prisma.agentBinding.count({
      where: {
        agentId: input.agentId,
        channelId: thread.channel.id,
        OR: [{ principalUserId: null }, { principalUserId: input.userId }],
      },
    })
    if (bound === 0) return null
    const channel = await prisma.channel.findUnique({
      where: { id: thread.channel.id },
      select: { teamId: true },
    })
    return { channelId: thread.channel.id, teamId: channel?.teamId ?? null }
  }

  /**
   * Steering a live session from the API.
   *
   * The worker owns a run's socket; these two verbs are a *person's*, pressed
   * in the viewer while they hold the claim, so they attach the same way the
   * tab capture does — through the sealed connect capability, with a timeout,
   * and closing the socket whatever happens. Neither is allowed to fail the
   * request it serves for a reason the reader cannot act on, so both answer
   * with a boolean rather than throwing.
   */
  const STEER_TIMEOUT_MS = 10_000

  const withLiveSession = async <T>(
    input: { sessionId: string; encryptionSecret: string },
    drive: (cdp: CdpClient) => Promise<T>,
  ): Promise<T | null> => {
    // Inside the try: loading the capability decrypts and reads the database,
    // and these two verbs promise their callers a boolean rather than a throw.
    // A rotated secret must not become a 500 on a button press.
    let abandoned = false
    let cdp: CdpClient | null = null
    const closeWhenIdle = (): void => {
      cdp?.close()
      cdp = null
    }
    try {
      const capability = await loadSessionCapability(prisma, {
        encryptionSecret: input.encryptionSecret,
        sessionId: input.sessionId,
      })
      if (!capability) return null
      const timeout = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('timed out')), STEER_TIMEOUT_MS).unref?.()
      })
      // The closure owns the socket, not the `finally` below. When the timeout
      // wins the race, `finally` used to close a `cdp` that was still null —
      // and the closure then went on to attach and *steer the browser anyway*,
      // seconds after the request had already answered. A navigation the caller
      // was told did not happen is worse than a leaked socket, and this leaked
      // both.
      return await Promise.race([
        (async () => {
          const client = await connectCdp(capability.connectUrl)
          if (abandoned) {
            client.close()
            throw new Error('abandoned')
          }
          cdp = client
          await client.attachToPage()
          if (abandoned) throw new Error('abandoned')
          return await drive(client)
        })().finally(closeWhenIdle),
        timeout,
      ])
    } catch {
      return null
    } finally {
      abandoned = true
      closeWhenIdle()
    }
  }

  /**
   * Resize the window a session is already running in.
   *
   * Browserbase fixes the browser window when the session is created, so this
   * is a page-level metrics override rather than a real window resize: the
   * page relays out and reports the new size, which is what a site responds
   * to. It is deliberately best effort — the stored pair is the durable
   * answer, and the next session opens at it either way.
   */
  const resizeLiveSession = async (input: {
    encryptionSecret: string
    sessionId: string
    viewport: BrowserViewport
  }): Promise<boolean> => {
    const done = await withLiveSession(input, async (cdp) => {
      await cdp.call('Emulation.setDeviceMetricsOverride', {
        deviceScaleFactor: 0,
        height: input.viewport.height,
        mobile: false,
        width: input.viewport.width,
      })
      return true
    })
    return done === true
  }

  const navigateLiveSession = async (input: {
    encryptionSecret: string
    sessionId: string
    url: string
  }): Promise<boolean> => {
    const done = await withLiveSession(input, async (cdp) => {
      await cdp.call('Page.navigate', { url: input.url })
      return true
    })
    return done === true
  }

  /**
   * The home page in force for this person, in this conversation.
   *
   * The cascade needs the team the conversation belongs to, which is the same
   * team the browser's connection is resolved against — so a team that runs
   * its own intranet start page gets it in its own channels without every
   * other team inheriting it.
   */
  const homepageFor = async (input: {
    organizationId: string
    threadId: string
    userId: string
  }): Promise<string> => {
    const thread = await findThreadForUser(
      prisma,
      input.threadId,
      input.userId,
      input.organizationId,
    )
    const channel = thread
      ? await prisma.channel.findUnique({
        select: { teamId: true },
        where: { id: thread.channel.id },
      })
      : null
    const resolved = await resolveScopedSetting(
      prisma,
      {
        organizationId: input.organizationId,
        teamId: channel?.teamId ?? null,
        userId: input.userId,
      },
      BROWSER_HOMEPAGE_SETTING_KEY,
    )
    return resolveBrowserHomepage(resolved.value)
  }


  /**
   * The tabs the agent's browser was last seen with — the chat's Browser column
   * when nothing is live. Readable by whoever can read the conversation the
   * agent is in, which is the audience its browser already belongs to.
   */
  app.get('/api/threads/:threadId/agents/:agentId/browser/tabs', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply

    const { threadId, agentId } = request.params as { threadId: string; agentId: string }
    const organizationId = actorContext.tenant.organizationId
    const reach = await agentInThread({
      organizationId,
      threadId,
      agentId,
      userId: actorContext.actor.actorId,
    })
    if (!reach) {
      sendApiError(reply, 404, 'AGENT_NOT_FOUND', 'Agent not found')
      return reply
    }
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
      return createApiResponse(AgentBrowserTabsResponseSchema.parse({ hasBrowser: false, tabs: [] }))
    }
    const tabs = await listAgentBrowserTabs(prisma, { organizationId, agentBrowserId: browser.id })
    // A picture of a signed-in page is that person's material, exactly as the
    // live view of it is. Someone outside the audience still learns where the
    // browser is — the site, not the page — and never what it showed.
    const allowed = await viewerMaySeeAgentBrowser(prisma, {
      agentBrowserId: browser.id,
      viewerId: actorContext.actor.actorId,
    })
    const visible = allowed
      ? tabs
      : tabs.map((tab) => ({
        ...tab,
        url: originOf(tab.url),
        screenshotDataUrl: null,
      }))
    return createApiResponse(AgentBrowserTabsResponseSchema.parse({ hasBrowser: true, tabs: visible }))
  })

  /**
   * Bring the agent's browser back, for a person, the way it was left.
   *
   * Bills the connection the agent's browser already lives on, never the
   * resumer's own; lives on the idle TTL and is extended while the column is
   * open. While it is up the agent's own `browser_open` is refused as "open in
   * another run", which is the one-live-session-per-browser rule doing its job.
   */
  app.post('/api/threads/:threadId/agents/:agentId/browser/resume', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireUserActor(actorContext, reply)) return reply

    const { threadId, agentId } = request.params as { threadId: string; agentId: string }
    const organizationId = actorContext.tenant.organizationId
    const reach = await agentInThread({
      organizationId,
      threadId,
      agentId,
      userId: actorContext.actor.actorId,
    })
    if (!reach) {
      sendApiError(reply, 404, 'AGENT_NOT_FOUND', 'Agent not found')
      return reply
    }
    const agent = await prisma.agent.findFirst({
      where: { id: agentId, organizationId },
      select: { visibility: true, ownerUserId: true },
    })
    if (!agent) {
      sendApiError(reply, 404, 'AGENT_NOT_FOUND', 'Agent not found')
      return reply
    }
    // Picking the browser up is seeing everything it is signed in to, so it
    // takes the same audience as watching it. A browser nobody signed in is
    // anyone's to open.
    const resumeScope = await browserScopeFor(prisma, {
      organizationId,
      agentId,
      viewerId: actorContext.actor.actorId,
    })
    const existing = resumeScope && await prisma.agentBrowser.findFirst({
      where: { organizationId, agentId, status: 'active', ...resumeScope },
      select: { id: true },
    })
    if (existing) {
      const allowed = await viewerMaySeeAgentBrowser(prisma, {
        agentBrowserId: existing.id,
        viewerId: actorContext.actor.actorId,
      })
      if (!allowed) {
        sendApiError(
          reply,
          403,
          'AGENT_BROWSER_SIGNED_IN_BY_OTHERS',
          'This browser is signed in by someone else, so only they can open it.',
        )
        return reply
      }
    }

    try {
      const resumed = await resumeAgentBrowser(
        {
          prisma,
          resolveSecret: (ref) => secretResolver.resolve(ref),
          encryptionSecret: authSecret ?? '',
        },
        {
          organizationId,
          agentId,
          agentVisibility: agent.visibility === 'private' ? 'private' : 'team',
          agentOwnerUserId: agent.ownerUserId ?? null,
          threadId,
          teamId: reach.teamId,
          // A browser with nothing to restore is one opening for the first
          // time; it lands on the home page in force for this person here
          // rather than on a blank page nobody can do anything with.
          homepage: await homepageFor({
            organizationId,
            threadId,
            userId: actorContext.actor.actorId,
          }),
          userId: actorContext.actor.actorId,
        },
      )
      return createApiResponse(ResumeAgentBrowserResponseSchema.parse(resumed))
    } catch (error) {
      // The lifecycle's sentence for this is written for the model ("wait for
      // the run … open a throwaway browser"); a person gets their own.
      if (isCloudBrowserError(error) && error.code === 'CLOUD_BROWSER_SESSION_ALREADY_OPEN') {
        sendApiError(
          reply,
          409,
          error.code,
          'This agent is using its browser right now. Wait for it to finish, then try again.',
        )
        return reply
      }
      if (sendCloudBrowserError(reply, error)) return reply
      throw error
    }
  })

  /**
   * "I'm done" on a resumed session: the last state is written and the
   * browser stops billing now, rather than when the idle window closes it.
   * Only for a session a person opened — a run's session is its run's to end.
   */
  app.delete('/api/browser-sessions/:sessionId', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireUserActor(actorContext, reply)) return reply

    const { sessionId } = request.params as { sessionId: string }
    const session = await loadViewableSession(prisma, {
      actorContext,
      sessionId,
      findThreadForUser,
    })
    if (!session || session.runId !== null) {
      sendApiError(reply, 404, 'CLOUD_BROWSER_SESSION_NOT_FOUND', 'Session not found')
      return reply
    }

    // Done hands the browser over; it does not tear it down. Ending the
    // session here meant the agent had to open a new one — a cold start, a new
    // context attach, and seconds of nothing — to act on the sign-in it had
    // just asked for. The browser stays up, the claim is released, and the
    // idle window closes it if nothing comes of the hand-over.
    // Answering false means this caller did not hold the claim — an expired
    // 90-second claim, or somebody else driving. Capturing their page and
    // waking the agent over a browser another person may now be controlling
    // is not this press's to do, so it stops here.
    const released = await releaseSessionControl(prisma, {
      sessionId,
      userId: actorContext.actor.actorId,
    })
    if (!released) return reply.code(204).send()
    // The state is saved now rather than when the window closes, so the agent
    // is told where the browser actually is.
    await captureUndrivenSessionTabs(prisma, {
      sessionId,
      encryptionSecret: authSecret ?? '',
    })

    const browser = session.agentBrowserId === null
      ? null
      : await prisma.agentBrowser.findUnique({
        select: { id: true },
        where: { id: session.agentBrowserId },
      })
    if (browser) {
      const channel = await prisma.channel.findFirst({
        select: { id: true, organizationId: true },
        where: { threads: { some: { id: session.threadId } } },
      })
      if (channel) {
        // The permission the waking agent needs, recorded on the browser
        // rather than on the run: a kickoff that has to queue behind an
        // in-flight run is batched into a follow-up, and a payload field is
        // lost on that path while a column survives it.
        await prisma.agentBrowser.update({
          data: { handedBackAt: new Date(), handedBackByUserId: actorContext.actor.actorId },
          where: { id: browser.id },
        })
        const tabs = await listAgentBrowserTabs(prisma, {
          organizationId: channel.organizationId,
          agentBrowserId: browser.id,
        })
        // Best effort on purpose: the person has finished either way, and a
        // wake-up that could not be enqueued must not fail their button.
        await nudgeAgentAfterHandover(prisma, {
          actorContext,
          agentBrowserId: browser.id,
          agentId: session.agentId,
          agentName: session.agentName,
          byUserId: actorContext.actor.actorId,
          channelId: channel.id,
          organizationId: channel.organizationId,
          tabs: tabs.map((tab) => ({ title: tab.title, url: tab.url })),
          threadId: session.threadId,
        }).catch(() => undefined)
      }
    }
    return reply.code(204).send()
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

    const browserScope = await browserScopeFor(prisma, {
      organizationId,
      agentId,
      viewerId: actorContext.actor.actorId,
    })
    const browser = browserScope && await prisma.agentBrowser.findFirst({
      where: { organizationId, agentId, status: 'active', ...browserScope },
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

    const resetScope = await browserScopeFor(prisma, {
      organizationId,
      agentId,
      viewerId: actorContext.actor.actorId,
    })
    const browser = resetScope && await prisma.agentBrowser.findFirst({
      where: { organizationId, agentId, status: 'active', ...resetScope },
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

    const reach = await agentInThread({
      organizationId,
      threadId,
      agentId,
      userId: actorContext.actor.actorId,
    })
    if (!reach) {
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
      ? await resizeLiveSession({
        encryptionSecret: authSecret ?? '',
        sessionId: live.id,
        viewport,
      })
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
    const session = await loadViewableSession(prisma, {
      actorContext,
      sessionId,
      findThreadForUser,
    })
    if (!session) {
      sendApiError(reply, 404, 'CLOUD_BROWSER_SESSION_NOT_FOUND', 'Session not found')
      return reply
    }
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
    const session = await loadViewableSession(prisma, {
      actorContext,
      sessionId,
      findThreadForUser,
    })
    if (!session) {
      sendApiError(reply, 404, 'CLOUD_BROWSER_SESSION_NOT_FOUND', 'Session not found')
      return reply
    }
    if (session.controlledByUserId !== actorContext.actor.actorId) {
      sendApiError(
        reply,
        409,
        'CLOUD_BROWSER_NOT_DRIVING',
        'Take control of the browser before sending it home.',
      )
      return reply
    }

    const url = await homepageFor({
      organizationId: actorContext.tenant.organizationId,
      threadId: session.threadId,
      userId: actorContext.actor.actorId,
    })
    const sent = await navigateLiveSession({
      encryptionSecret: authSecret ?? '',
      sessionId: session.id,
      url,
    })
    if (!sent) {
      sendApiError(
        reply,
        502,
        'CLOUD_BROWSER_UNREACHABLE',
        'The browser did not answer. Try again in a moment.',
      )
      return reply
    }
    return createApiResponse(BrowserHomeResponseSchema.parse({ url }))
  })
}


