// The API drain: what a replica does between SIGTERM and exit.
//
// The trap this covers is Fastify's: `forceCloseConnections` defaults to
// `'idle'` (fastify 5.8.4, `lib/server.js:131-137`), which closes only *idle*
// sockets — and an open SSE stream is an in-flight request, so `app.close()`
// alone waits for a client that may never hang up. Every assertion below is
// about the hub doing that work first: the shutdown frame, the `retry:` hint,
// the 1012 WebSocket close, and `app.close()` actually resolving.
//
// Postgres-backed: `createRealtimeHub` opens a real pool and a real LISTEN
// client, and the SSE hydrate path queries `thread_stream_events`.

import assert from 'node:assert/strict'
import { request as httpRequest } from 'node:http'
import type { AddressInfo } from 'node:net'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import websocket from '@fastify/websocket'
import Fastify, { type FastifyInstance } from 'fastify'
import type { PrismaClient } from '@prisma/client'

import {
  createLifecycleState,
  drainApiServer,
  isDraining,
  runShutdown,
} from '../src/lifecycle.js'
import { createRealtimeHub } from '../src/realtime/hub.js'

const databaseUrl = process.env.DATABASE_URL
const dbTest = databaseUrl ? test : test.skip

type SseClient = {
  body: () => string
  ended: Promise<void>
  firstByte: Promise<void>
}

const openSseClient = (url: string): SseClient => {
  let received = ''
  let resolveFirstByte = (): void => {}
  const firstByte = new Promise<void>((resolve) => {
    resolveFirstByte = resolve
  })

  const ended = new Promise<void>((resolve, reject) => {
    const clientRequest = httpRequest(url, { method: 'GET' }, (response) => {
      response.setEncoding('utf8')
      response.on('data', (chunk: string) => {
        received += chunk
        resolveFirstByte()
      })
      response.on('end', () => resolve())
      response.on('error', reject)
    })
    clientRequest.on('error', reject)
    clientRequest.end()
  })

  return { body: () => received, ended, firstByte }
}

dbTest('drain ends every SSE stream with a shutdown frame and closes WebSockets with 1012', async () => {
  const threadId = randomUUID()
  const organizationId = randomUUID()
  const userId = randomUUID()

  const hub = await createRealtimeHub({
    databaseUrl: databaseUrl!,
    poolMax: 2,
    poolMin: 0,
    // The hub uses prisma only for delivery entitlements, which this test's
    // single unscoped thread stream never consults.
    prisma: {} as unknown as PrismaClient,
  })

  const app = Fastify()
  await app.register(websocket)
  app.addHook('onClose', async () => {
    await hub.close()
  })

  // Mirrors `routes/threads.ts`: hijack, write the SSE preamble, hand the raw
  // response to the hub, and deregister when the socket goes away.
  app.get('/test/thread-stream', async (request, reply) => {
    reply.hijack()
    reply.raw.writeHead(200, {
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'Content-Type': 'text/event-stream',
    })
    reply.raw.write(': connected\n\n')

    const connection = await hub.addSseConnection(threadId, reply.raw)
    request.raw.on('close', () => {
      hub.removeSseConnection(connection)
    })
    return reply
  })

  // Mirrors `routes/events.ts` (the per-user stream).
  app.get('/test/user-stream', async (request, reply) => {
    reply.hijack()
    reply.raw.writeHead(200, {
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'Content-Type': 'text/event-stream',
    })
    reply.raw.write(': connected\n\n')

    const connection = await hub.addSseConnection(
      { kind: 'user', channelIds: [], organizationId, scopes: [], userId },
      reply.raw,
    )
    request.raw.on('close', () => {
      hub.removeSseConnection(connection)
    })
    return reply
  })

  // Mirrors `routes/activity.ts`, including the closer the drain reaches for.
  app.get('/test/activity', { websocket: true }, (socket) => {
    hub.registerWsConnection({
      organizationId,
      userId,
      send: (message) => socket.send(JSON.stringify(message)),
      close: (code, reason) => {
        socket.close(code, reason)
      },
    })
  })

  await app.listen({ host: '127.0.0.1', port: 0 })
  const { port } = app.server.address() as AddressInfo

  const threadStream = openSseClient(`http://127.0.0.1:${port}/test/thread-stream`)
  const userStream = openSseClient(`http://127.0.0.1:${port}/test/user-stream`)
  await threadStream.firstByte
  await userStream.firstByte

  const socket = new WebSocket(`ws://127.0.0.1:${port}/test/activity`)
  const wsClosed = new Promise<{ code: number; reason: string }>((resolve, reject) => {
    socket.addEventListener('close', (event) => {
      resolve({ code: event.code, reason: event.reason })
    })
    socket.addEventListener('error', () => reject(new Error('websocket errored')))
  })
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve())
    socket.addEventListener('error', () => reject(new Error('websocket failed to open')))
  })

  const lifecycle = createLifecycleState()
  assert.equal(isDraining(lifecycle), false, 'precondition: the server is serving normally')

  // The whole drain, exactly as the signal handler runs it.
  await drainApiServer({ app, hub, lifecycle })

  // `app.close()` resolved. With the hub's stream teardown removed this line is
  // never reached: Fastify's 'idle' close waits on the two open SSE requests.
  assert.equal(
    isDraining(lifecycle),
    true,
    'readiness must answer 503 for the rest of the drain',
  )

  await threadStream.ended
  await userStream.ended

  for (const [name, stream] of [
    ['thread', threadStream],
    ['user', userStream],
  ] as const) {
    const body = stream.body()
    assert.ok(
      body.includes('event: shutdown'),
      `${name} stream must receive an explicit shutdown event, got: ${JSON.stringify(body)}`,
    )
    assert.ok(
      body.includes('retry: 2000'),
      `${name} stream must carry retry: 2000 so an EventSource reconnects at once`,
    )
    assert.ok(
      body.indexOf('retry: 2000') < body.indexOf('event: shutdown'),
      `${name} stream must send retry: before the shutdown event`,
    )
    assert.ok(!body.includes('id: '), `${name} shutdown frame must not move Last-Event-ID`)
  }

  const closed = await wsClosed
  assert.equal(closed.code, 1012, 'WebSockets close with 1012 (service restart), not 1006')
  assert.equal(closed.reason, 'restart')

  // Closed for business: the listener is gone, so a new connection is refused.
  await assert.rejects(
    new Promise((resolve, reject) => {
      const probe = httpRequest(`http://127.0.0.1:${port}/test/thread-stream`, resolve)
      probe.on('error', reject)
      probe.end()
    }),
  )
})

// Found live: against a stale `@nessie/config` build `config.shutdownTimeoutMs`
// arrived `undefined`, `setTimeout(fn, undefined)` fired on the next tick, and
// SIGTERM became `exit(1)` 67 ms later with nothing drained — strictly worse
// than having no deadline at all.
test('a shutdown timeout that is not a positive number falls back instead of firing at once', async () => {
  const messages: string[] = []
  const exits: number[] = []

  await runShutdown('SIGTERM', {
    app: { close: async () => {} } as unknown as FastifyInstance,
    hub: { closeLiveConnections: () => {} },
    lifecycle: createLifecycleState(),
    timeoutMs: undefined as unknown as number,
    exit: ((code: number) => {
      exits.push(code)
    }) as unknown as (code: number) => never,
    log: (message: string) => messages.push(message),
  })

  assert.deepEqual(exits, [0], 'the drain must still run to completion and exit 0')
  assert.ok(
    messages.some((message) => message.includes('falling back to 25000ms')),
    `the bad value must be reported, got: ${JSON.stringify(messages)}`,
  )
})
