import assert from 'node:assert/strict'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import test from 'node:test'

import websocket from '@fastify/websocket'
import Fastify from 'fastify'

import { registerBrowserCloudViewerRoutes } from '../src/routes/browser-cloud-viewer.js'

const sessionId = '11111111-1111-4111-8111-111111111111'
const actorContext = {
  actor: { actorId: '22222222-2222-4222-8222-222222222222' },
  tenant: { organizationId: '33333333-3333-4333-8333-333333333333' },
}

const activeSession = {
  agentId: '44444444-4444-4444-8444-444444444444',
  agentName: 'Private agent',
  browserbaseSessionId: 'browserbase-session',
  canControl: true,
  controlledByUserId: actorContext.actor.actorId,
  controlLeaseActive: true,
  endedAt: null,
  expiresAt: new Date(Date.now() + 60_000),
  id: sessionId,
  personalAccess: false,
  personalAccessGrantId: null,
  runId: null,
  shared: false,
  startedAt: new Date(),
  status: 'active',
  viewport: { height: 800, width: 1280 },
  viewerMode: 'controller' as const,
}

const deferred = <T>() => {
  let release = (_value: T): void => undefined
  const promise = new Promise<T>((resolve) => { release = resolve })
  return { promise, release }
}

test('a screenshot captured before a browser grant revoke is never returned', async () => {
  const app = Fastify()
  const started = deferred<void>()
  const capture = deferred<string | null>()
  let grantActive = true
  let grantChecks = 0
  registerBrowserCloudViewerRoutes(app, {
    authSecret: 'test-secret',
    authenticateRequest: async () => ({ actorContext }),
    browserViewerOperations: {
      agentHasBrowserOpenGrant: async () => {
        grantChecks += 1
        return grantActive
      },
      captureLiveBrowserScreenshot: async () => {
        started.release()
        return capture.promise
      },
      loadViewableSession: async () => activeSession,
    },
    prisma: {},
    requireActorContext: () => actorContext,
  } as never)
  await app.ready()
  try {
    const response = app.inject({ method: 'GET', url: `/api/browser-sessions/${sessionId}/screenshot` })
    await started.promise
    grantActive = false
    capture.release('data:image/png;base64,private-frame')

    const result = await response
    assert.equal(result.statusCode, 404)
    assert.equal(result.body.includes('private-frame'), false)
    assert.equal(grantChecks, 2)
  } finally {
    await app.close()
  }
})

test('a screenshot captured before its bearer is revoked is never returned', async () => {
  const app = Fastify()
  const started = deferred<void>()
  const capture = deferred<string | null>()
  let revoked = false
  let authenticationChecks = 0
  registerBrowserCloudViewerRoutes(app, {
    authSecret: 'test-secret',
    authenticateRequest: async () => {
      authenticationChecks += 1
      return revoked ? null : { actorContext }
    },
    browserViewerOperations: {
      agentHasBrowserOpenGrant: async () => true,
      captureLiveBrowserScreenshot: async () => {
        started.release()
        return capture.promise
      },
      loadViewableSession: async () => activeSession,
    },
    prisma: {},
    requireActorContext: () => actorContext,
  } as never)
  await app.ready()
  try {
    const response = app.inject({ method: 'GET', url: `/api/browser-sessions/${sessionId}/screenshot` })
    await started.promise
    revoked = true
    capture.release('data:image/png;base64,private-frame')

    const result = await response
    assert.equal(result.statusCode, 404)
    assert.equal(result.body.includes('private-frame'), false)
    assert.equal(authenticationChecks, 1)
  } finally {
    await app.close()
  }
})

test('the removed HTTP input endpoint is not an alternate control path', async () => {
  const app = Fastify()
  registerBrowserCloudViewerRoutes(app, {
    prisma: {},
    requireActorContext: () => actorContext,
  } as never)
  await app.ready()
  try {
    const result = await app.inject({
      method: 'POST',
      payload: { type: 'reload' },
      url: `/api/browser-sessions/${sessionId}/human-input`,
    })
    assert.equal(result.statusCode, 404)
  } finally {
    await app.close()
  }
})

import { registerBrowserCloudCanvasRoutes } from '../src/routes/browser-cloud-canvas.js'

test('a canvas gesture queued behind a lock is dropped when access changes', async () => {
  const app = Fastify()
  await app.register(websocket)
  let access = true
  let dispatched = 0
  const lockEntered = deferred<void>()
  const unlock = deferred<void>()
  const cdp = {
    activatePage: async () => undefined,
    attachToPage: async () => 'page',
    call: async (method: string) => {
      if (method === 'Page.captureScreenshot') return { data: 'frame' }
      if (method === 'Runtime.evaluate') return { result: { value: 'https://example.test' } }
      if (method === 'Page.getLayoutMetrics') return { cssVisualViewport: { clientHeight: 800, clientWidth: 1280 } }
      return {}
    },
    close: () => undefined,
    closed: Promise.resolve(),
    pageSessionId: () => 'page',
    targets: async () => [],
  }
  app.addHook('onRequest', (request, _reply, done) => {
    ;(request as unknown as { actorContext: typeof actorContext }).actorContext = actorContext
    done()
  })
  registerBrowserCloudCanvasRoutes(app, {
    authSecret: 'test-secret',
    authenticateRequest: async () => ({ actorContext }),
    browserCanvasOperations: {
      agentHasBrowserOpenGrant: async () => access,
      claimSessionControl: async () => true,
      connectCdp: async () => cdp,
      dispatchHumanBrowserInput: async () => { dispatched += 1 },
      loadSessionCapability: async () => ({ connectUrl: 'wss://example.test/cdp' }),
      loadViewableSession: async () => access ? activeSession : null,
      touchResumedSession: async () => undefined,
      withCloudBrowserSessionControlLock: async (_prisma, _input, drive) => {
        lockEntered.release()
        await unlock.promise
        return drive({} as never)
      },
    },
    prisma: {},
  } as never)
  await app.listen({ host: '127.0.0.1', port: 0 })
  const { port } = app.server.address() as AddressInfo
  const socket = new WebSocket(`ws://127.0.0.1:${port}/api/browser-sessions/${sessionId}/canvas`)
  try {
    await once(socket, 'open')
    await once(socket, 'message')
    socket.send(JSON.stringify({ type: 'input', input: { type: 'reload' } }))
    await lockEntered.promise
    access = false
    unlock.release()
    const [close] = await once(socket, 'close') as [{ code: number }]
    assert.equal(close.code, 1011)
    assert.equal(dispatched, 0)
  } finally {
    socket.close()
    await app.close()
  }
})
