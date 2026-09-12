import type { FastifyInstance } from 'fastify'
import {
  claimSessionControl,
  CONTROL_CLAIM_TTL_MS,
  connectCdp,
  touchResumedSession,
  loadSessionCapability,
  type CdpClient,
  withCloudBrowserSessionControlLock,
} from '@nessie/browser-cloud'
import { z } from 'zod'

import { HumanBrowserInputSchema } from '../contracts/browser-cloud.js'
import { agentHasBrowserOpenGrant, loadViewableSession } from './browser-cloud-access.js'
import { dispatchHumanBrowserInput } from './browser-cloud-live-session.js'
import type { RouteDeps } from './types.js'

type BrowserCloudCanvasRouteDeps = RouteDeps & {
  /** Route-local seams keep the control-lock authorization race testable without provider I/O. */
  browserCanvasOperations?: {
    agentHasBrowserOpenGrant?: typeof agentHasBrowserOpenGrant
    claimSessionControl?: typeof claimSessionControl
    connectCdp?: typeof connectCdp
    dispatchHumanBrowserInput?: typeof dispatchHumanBrowserInput
    loadSessionCapability?: typeof loadSessionCapability
    loadViewableSession?: typeof loadViewableSession
    touchResumedSession?: typeof touchResumedSession
    withCloudBrowserSessionControlLock?: typeof withCloudBrowserSessionControlLock
  }
}

const CanvasMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('input'), input: HumanBrowserInputSchema }).strict(),
  z.object({ type: z.literal('ping') }).strict(),
])
const MAX_CANVAS_MESSAGE_BYTES = 12_000
const MAX_SOCKET_BUFFERED_BYTES = 1_000_000
const MAX_QUEUED_INPUT_BYTES = 32_000
const MAX_QUEUED_INPUTS = 32

/**
 * A per-viewer, server-mediated canvas transport.
 *
 * The CDP socket is intentionally local to this websocket handler: it closes
 * on disconnect, auth revocation, or a control transfer and is never a
 * process-wide browser cache. Frames and human input have separate closed
 * protocols; neither reaches logs, storage, messages, or a model.
 */
export const registerBrowserCloudCanvasRoutes = (
  app: FastifyInstance,
  deps: BrowserCloudCanvasRouteDeps,
): void => {
  const { authSecret, prisma } = deps
  const hasBrowserOpenGrant = deps.browserCanvasOperations?.agentHasBrowserOpenGrant
    ?? agentHasBrowserOpenGrant
  const claimControl = deps.browserCanvasOperations?.claimSessionControl ?? claimSessionControl
  const connect = deps.browserCanvasOperations?.connectCdp ?? connectCdp
  const dispatchInput = deps.browserCanvasOperations?.dispatchHumanBrowserInput
    ?? dispatchHumanBrowserInput
  const loadCapability = deps.browserCanvasOperations?.loadSessionCapability
    ?? loadSessionCapability
  const loadSession = deps.browserCanvasOperations?.loadViewableSession ?? loadViewableSession
  const touchSession = deps.browserCanvasOperations?.touchResumedSession ?? touchResumedSession
  const withControlLock = deps.browserCanvasOperations?.withCloudBrowserSessionControlLock
    ?? withCloudBrowserSessionControlLock
  app.get('/api/browser-sessions/:sessionId/canvas', { websocket: true }, async (socket, request) => {
    let actorContext = request.actorContext
    const { sessionId } = request.params as { sessionId: string }
    let closed = false
    let cdp: CdpClient | null = null
    let frameTimer: NodeJS.Timeout | null = null
    let heartbeatTimer: NodeJS.Timeout | null = null
    let sending = false
    let inputTail = Promise.resolve()
    let queuedInputBytes = 0
    let queuedInputs = 0
    let appliedViewport: string | null = null

    const close = (code = 1000, reason = 'Closed'): void => {
      if (closed) return
      closed = true
      if (frameTimer) clearInterval(frameTimer)
      if (heartbeatTimer) clearInterval(heartbeatTimer)
      cdp?.close()
      cdp = null
      if (socket.readyState < 2) socket.close(code, reason)
    }
    // Install this before any awaited provider operation. A disconnect while
    // connecting must close a late CDP client rather than leave it running.
    socket.on('close', () => close())

    const send = (value: unknown): boolean => {
      if (closed || socket.readyState !== 1 || socket.bufferedAmount > MAX_SOCKET_BUFFERED_BYTES) {
        return false
      }
      socket.send(JSON.stringify(value))
      return true
    }
    const current = async (database: RouteDeps['prisma'] = prisma) => {
      // A WebSocket request has one initial auth hook, but it may live through
      // logout, token/session revocation, deactivation, or an owner demotion.
      // Reuse the same live request verifier before every privileged action.
      const authenticated = await deps.authenticateRequest(request, null)
      if (!authenticated) return null
      actorContext = authenticated.actorContext
      const session = await loadSession(database, { actorContext, sessionId })
      if (!session || session.status !== 'active' || session.expiresAt <= new Date()) return null
      if (!(await hasBrowserOpenGrant(database, {
        agentId: session.agentId,
        organizationId: actorContext.tenant.organizationId,
      }))) return null
      return session
    }
    const initial = actorContext ? await current() : null
    if (!initial) {
      close(4003, 'Browser is unavailable')
      return
    }
    const capability = await loadCapability(prisma, {
      encryptionSecret: encryptionKeyRing, sessionId: initial.id,
    })
    if (!capability || closed) {
      close(1011, 'Browser connection unavailable')
      return
    }
    try {
      const connected = await connect(capability.connectUrl)
      if (closed) {
        connected.close()
        return
      }
      cdp = connected
      await connected.attachToPage()
      if (closed) {
        connected.close()
        cdp = null
        return
      }
    } catch {
      close(1011, 'Browser connection unavailable')
      return
    }

    const applyViewport = async (session: { viewport: { height: number; width: number } }): Promise<void> => {
      if (!cdp) return
      const key = `${session.viewport.width}x${session.viewport.height}`
      if (appliedViewport === key) return
      await cdp.call('Emulation.setDeviceMetricsOverride', {
        deviceScaleFactor: 0,
        height: session.viewport.height,
        mobile: false,
        width: session.viewport.width,
      })
      appliedViewport = key
    }
    const sendFrame = async (): Promise<void> => {
      if (closed || sending || !cdp || socket.bufferedAmount > MAX_SOCKET_BUFFERED_BYTES) return
      sending = true
      try {
        const session = await current()
        if (!session || closed) return close(4003, 'Browser access changed')
        await applyViewport(session)
        const [screenshot, location, targets] = await Promise.all([
          cdp.call('Page.captureScreenshot', { format: 'jpeg', optimizeForSpeed: true, quality: 55 }),
          cdp.call('Runtime.evaluate', {
            expression: 'location.href', returnByValue: true, silent: true,
          }),
          cdp.targets(),
        ])
        if (closed || typeof screenshot.data !== 'string') return
        // Recheck after capture. A frame taken before a control/privacy change
        // never crosses that new audience boundary.
        if (!(await current()) || closed) return close(4003, 'Browser access changed')
        const value = (location.result as { value?: unknown } | undefined)?.value
        send({
          type: 'frame',
          imageDataUrl: `data:image/jpeg;base64,${screenshot.data}`,
          pageUrl: typeof value === 'string' ? value : null,
          tabs: targets.filter((target) => target.type === 'page').map((target) => ({
            id: target.targetId,
            title: target.title,
            url: target.url,
          })),
          viewport: session.viewport,
        })
      } catch {
        close(1011, 'Browser connection lost')
      } finally {
        sending = false
      }
    }
    const renewController = async (): Promise<void> => {
      const session = await current()
      if (!session || closed) return close(4003, 'Browser access changed')
      if (!session.canControl || session.viewerMode !== 'controller') return
      if (!(await claimControl(prisma, {
        sessionId: session.id,
        userId: actorContext?.actor.actorId ?? '',
      }))) close(4003, 'Browser control expired')
    }

    frameTimer = setInterval(() => { void sendFrame() }, 450)
    heartbeatTimer = setInterval(() => { void renewController() }, 25_000)
    socket.on('message', (raw: Buffer) => {
      if (closed || raw.byteLength > MAX_CANVAS_MESSAGE_BYTES
        || queuedInputs >= MAX_QUEUED_INPUTS
        || queuedInputBytes + raw.byteLength > MAX_QUEUED_INPUT_BYTES) {
        close(4008, 'Browser input queue is full')
        return
      }
      queuedInputs += 1
      queuedInputBytes += raw.byteLength
      inputTail = inputTail.then(async () => {
        if (closed) return
        let payload: unknown
        try { payload = JSON.parse(raw.toString()) } catch {
          send({ type: 'error', code: 'INVALID_JSON' })
          return
        }
        const parsed = CanvasMessageSchema.safeParse(payload)
        if (!parsed.success) {
          send({ type: 'error', code: 'INVALID_INPUT' })
          return
        }
        if (parsed.data.type === 'ping') {
          send({ type: 'pong' })
          return
        }
        const input = parsed.data.input
        const session = await current()
        if (closed || !session || !session.canControl || session.viewerMode !== 'controller'
          || !(await claimControl(prisma, {
            sessionId: session.id,
            userId: actorContext?.actor.actorId ?? '',
          }))) {
          close(4003, 'Browser control expired')
          return
        }
        if (closed || !cdp) return
        try {
          await withControlLock(prisma, { sessionId: session.id }, async (tx) => {
            // The socket may have waited behind a worker turn or another
            // gesture. Reauthenticate and recheck its full audience under the
            // same lock immediately before CDP sees the input.
            const fresh = await current(tx as RouteDeps['prisma'])
            if (!fresh || !fresh.canControl || fresh.viewerMode !== 'controller' || closed) {
              throw new Error('browser access changed')
            }
            // `claimSessionControl` renewed the lease above. This locked read
            // proves that a hand-back or worker turn did not win before CDP
            // received the gesture; those writers share this same session lock.
            const stillDriving = await tx.cloudBrowserSession.count({
              where: {
                id: fresh.id,
                status: 'active',
                expiresAt: { gt: new Date() },
                controlledByUserId: actorContext?.actor.actorId ?? '',
                controlClaimedAt: { gt: new Date(Date.now() - CONTROL_CLAIM_TTL_MS) },
              },
            })
            if (stillDriving !== 1) throw new Error('browser control changed')
            await dispatchInput(cdp!, input)
          })
          // A person actively driving a resumed browser extends its bounded
          // idle window. Frame polling and automatic lease heartbeats do not.
          if (session.runId === null && !session.personalAccess) {
            await touchSession(prisma, { sessionId: session.id })
          }
          if (!closed) void sendFrame()
        } catch {
          // CDP delivery is ambiguous; never replay the human gesture.
          close(1011, 'Browser input was not confirmed')
        }
      }).catch(() => close(1011, 'Browser input failed')).finally(() => {
        queuedInputs -= 1
        queuedInputBytes -= raw.byteLength
      })
    })
    await sendFrame()
  })
}
