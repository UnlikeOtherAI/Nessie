import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'
import Fastify from 'fastify'

import { registerBoardSourceConnectionRoutes } from '../src/routes/board-sources/connections.js'
import type { RouteDeps } from '../src/routes/types.js'

const organizationId = '00000000-0000-4000-8000-000000000001'
const userId = '00000000-0000-4000-8000-000000000004'
const connectionId = '00000000-0000-4000-8000-000000000009'

/**
 * The list route parses what it builds through
 * `BoardSourceConnectionRecordSchema`, so a field added to the contract and not
 * to the mapping is a 500 for every caller — which is exactly what shipped once.
 * These tests exist so the next added field cannot do it again.
 */
const connectionRow = (over: Record<string, unknown> = {}) => ({
  id: connectionId,
  provider: 'linear',
  status: 'active',
  authMethod: 'api_key',
  externalAccountId: 'linear-user-1',
  externalTenantId: 'linear-org-1',
  ownerUserId: userId,
  owner: { displayName: 'Ondrej' },
  lastVerifiedAt: new Date('2026-09-05T00:00:00.000Z'),
  createdAt: new Date('2026-09-01T00:00:00.000Z'),
  ...over,
})

const buildApp = async (rows: ReturnType<typeof connectionRow>[]) => {
  const app = Fastify()
  const prisma = {
    boardSourceConnection: { findMany: async () => rows },
  } as unknown as PrismaClient

  registerBoardSourceConnectionRoutes(app, {
    prisma,
    config: { auth: { secret: 'test-secret' }, api: { publicUrl: 'http://localhost:5454' } },
    requireActorContext: () => ({
      actor: { actorId: userId, actorType: 'user', roles: ['owner'] },
      tenant: { organizationId },
    }),
    requireUserActor: () => true,
  } as unknown as RouteDeps)

  await app.ready()
  return app
}

test('a connection row survives the contract it is parsed against', async () => {
  const app = await buildApp([connectionRow()])
  const response = await app.inject({ method: 'GET', url: '/api/board-sources/connections' })
  assert.equal(response.statusCode, 200, response.body)
  const [record] = JSON.parse(response.body).data
  assert.equal(record.authMethod, 'api_key')
  assert.equal(record.isOwnedByViewer, true)
  await app.close()
})

test('an OAuth connection reports the method that made it', async () => {
  const app = await buildApp([connectionRow({ authMethod: 'oauth' })])
  const response = await app.inject({ method: 'GET', url: '/api/board-sources/connections' })
  assert.equal(response.statusCode, 200, response.body)
  assert.equal(JSON.parse(response.body).data[0].authMethod, 'oauth')
  await app.close()
})

test('no route ever echoes a credential back', async () => {
  const app = await buildApp([connectionRow()])
  const response = await app.inject({ method: 'GET', url: '/api/board-sources/connections' })
  const body = response.body.toLowerCase()
  for (const leak of ['accesstoken', 'ciphertext', 'credential', 'apikey']) {
    assert.equal(body.includes(leak), false, `the list route leaked ${leak}`)
  }
  await app.close()
})
