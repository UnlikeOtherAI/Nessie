// `/api/health` and `/api/health/ready` are what a load balancer asks before it
// sends traffic here, so what makes them fail is a deployment-wide decision.
//
// Two things used to be wrong. Readiness 503'd whenever every worker heartbeat
// was stale, which means a worker outage — or an ordinary worker deploy — would
// have pulled *every* API replica out of the pool at once. And nothing marked a
// replica as going away, so a draining process kept being handed new requests
// right up to the moment it closed its sockets.
//
// No database: the readiness path is stubbed at the Prisma boundary so the
// worker-status and database-failure cases are both reachable on demand.

import assert from 'node:assert/strict'
import test from 'node:test'

import Fastify from 'fastify'
import type { PrismaClient } from '@prisma/client'

import { beginDraining, createLifecycleState, isDraining } from '../src/lifecycle.js'
import { registerHealthRoutes } from '../src/routes/health.js'
import type { RouteDeps } from '../src/routes/types.js'

type PrismaStub = {
  databaseUp: boolean
  runners: { heartbeatAt: Date | null; status: string }[]
}

const buildHealthApp = (stub: PrismaStub) => {
  const prisma = {
    $queryRaw: async () => {
      if (!stub.databaseUp) {
        throw new Error('connection refused')
      }
      return [{ '?column?': 1 }]
    },
    executionRunner: {
      findMany: async () => stub.runners,
    },
  } as unknown as PrismaClient

  const app = Fastify()
  // The drain flag the routes read is per built server, so each test gets its
  // own and nothing leaks from the draining case into the others.
  const lifecycle = createLifecycleState()
  registerHealthRoutes(app, { lifecycle, prisma } as unknown as RouteDeps)
  return { app, lifecycle }
}

const readyBody = (payload: string) =>
  (JSON.parse(payload) as { data: { ready: boolean; checks: { worker: string } } }).data

test('readiness is 200 on a live database even with no worker heartbeat at all', async () => {
  const { app } = buildHealthApp({ databaseUp: true, runners: [] })

  const response = await app.inject({ method: 'GET', url: '/api/health/ready' })

  assert.equal(response.statusCode, 200)
  const body = readyBody(response.payload)
  assert.equal(body.ready, true)
  // Reported, deliberately, but no longer load-bearing: a worker outage must
  // not empty the load balancer of API replicas.
  assert.equal(body.checks.worker, 'down')
  await app.close()
})

test('readiness is 200 when the worker heartbeat is merely stale', async () => {
  const { app } = buildHealthApp({
    databaseUp: true,
    runners: [{ heartbeatAt: new Date(Date.now() - 120_000), status: 'active' }],
  })

  const response = await app.inject({ method: 'GET', url: '/api/health/ready' })

  assert.equal(response.statusCode, 200)
  assert.equal(readyBody(response.payload).checks.worker, 'stale')
  await app.close()
})

test('readiness is 503 when the database round trip fails', async () => {
  const { app } = buildHealthApp({
    databaseUp: false,
    runners: [{ heartbeatAt: new Date(), status: 'active' }],
  })

  const response = await app.inject({ method: 'GET', url: '/api/health/ready' })

  assert.equal(response.statusCode, 503)
  assert.equal(readyBody(response.payload).ready, false)
  await app.close()
})

test('liveness is a flat 200 while the process is serving', async () => {
  const { app } = buildHealthApp({ databaseUp: true, runners: [] })

  const response = await app.inject({ method: 'GET', url: '/api/health' })

  assert.equal(response.statusCode, 200)
  assert.equal(
    (JSON.parse(response.payload) as { data: { status: string } }).data.status,
    'ok',
  )
  await app.close()
})

// `beginDraining` is one-way, exactly as a real shutdown is — but it is scoped
// to this server, so the tests above keep serving on their own apps.
test('a draining replica reports 503 on both health endpoints', async () => {
  const { app, lifecycle } = buildHealthApp({
    databaseUp: true,
    runners: [{ heartbeatAt: new Date(), status: 'active' }],
  })

  assert.equal(isDraining(lifecycle), false)
  const beforeDrain = await app.inject({ method: 'GET', url: '/api/health/ready' })
  assert.equal(beforeDrain.statusCode, 200)

  beginDraining(lifecycle)

  const ready = await app.inject({ method: 'GET', url: '/api/health/ready' })
  assert.equal(ready.statusCode, 503, 'a draining replica must not be routed new work')
  assert.equal(readyBody(ready.payload).ready, false)
  // The database is still fine — draining is the only reason it says no.
  assert.equal(
    (JSON.parse(ready.payload) as { data: { checks: { database: boolean } } })
      .data.checks.database,
    true,
  )

  const live = await app.inject({ method: 'GET', url: '/api/health' })
  assert.equal(live.statusCode, 503)
  assert.equal(
    (JSON.parse(live.payload) as { data: { status: string } }).data.status,
    'draining',
  )

  await app.close()
})
