import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'
import Fastify from 'fastify'
import {
  type BoardSourceAdapter,
  clearBoardSourceAdapters,
  registerBoardSourceAdapter,
} from '@nessie/board-sources'
import { sealSecret } from '@nessie/runtime'

import { registerBoardSourceRoutes } from '../src/routes/board-sources/sources.js'
import type { RouteDeps } from '../src/routes/types.js'

const organizationId = '00000000-0000-4000-8000-000000000001'
const projectId = '00000000-0000-4000-8000-000000000002'
const sourceId = '00000000-0000-4000-8000-000000000003'
const userId = '00000000-0000-4000-8000-000000000004'
const connectionId = '00000000-0000-4000-8000-000000000009'
const ENCRYPTION_SECRET = 'test-encryption-secret'

const sourceRow = (over: Record<string, unknown> = {}) => ({
  id: sourceId,
  projectId,
  organizationId,
  connectionId,
  provider: 'linear',
  name: 'KiloMayo',
  container: { teamId: 'team-1' },
  containerKey: 'team-1',
  writeMode: 'read_only',
  syncWindowDays: 30,
  stateMapping: [],
  fieldMappings: [],
  healthState: 'active',
  healthReason: null,
  healthDetail: null,
  lastSyncCompletedAt: new Date('2026-09-06T09:00:00.000Z'),
  lastSyncStartedAt: new Date('2026-09-06T09:00:00.000Z'),
  lastErrorCode: null,
  webhookExternalId: null,
  connection: {
    ownerUserId: userId,
    externalTenantId: 'tenant-1',
    owner: { displayName: 'Ondrej' },
  },
  _count: { links: 12 },
  ...over,
})

/** Enough of an adapter to declare a poll and record a webhook removal. */
const stubAdapter = (removals: string[]): BoardSourceAdapter =>
  ({
    provider: 'linear',
    incrementalPollingIntervalMs: 5 * 60 * 1000,
    allowedHosts: ['api.linear.app'],
    auth: {
      apiKey: {
        form: { createUrl: 'x', createLabel: 'x', fields: [] },
        verify: async () => {
          throw new Error('unused')
        },
      },
    },
    removeWebhook: async (_ctx, _container, externalId: string) => {
      removals.push(externalId)
    },
  }) as unknown as BoardSourceAdapter

const buildApp = async (input: {
  removals: string[]
  rows: ReturnType<typeof sourceRow>[]
  deleted?: number
}) => {
  const app = Fastify()
  const prisma = {
    project: { findFirst: async () => ({ id: projectId, organizationId }) },
    boardSource: {
      findMany: async () => input.rows,
      findFirst: async () => input.rows[0] ?? null,
      deleteMany: async () => ({ count: input.deleted ?? 1 }),
    },
    boardSourceConnection: {
      findUnique: async () => ({
        id: connectionId,
        organizationId,
        ownerUserId: userId,
        provider: 'linear',
        status: 'active',
        externalAccountId: 'linear-user-1',
        externalTenantId: 'tenant-1',
        grantedScopes: [],
        credential: {
          accessTokenCiphertext: sealSecret(ENCRYPTION_SECRET, 'lin_api_key'),
          refreshTokenCiphertext: null,
          expiresAt: null,
        },
      }),
    },
    organizationMember: { count: async () => 1 },
  } as unknown as PrismaClient

  clearBoardSourceAdapters()
  registerBoardSourceAdapter('linear', () => stubAdapter(input.removals))

  registerBoardSourceRoutes(app, {
    prisma,
    config: { auth: { secret: ENCRYPTION_SECRET }, api: { publicUrl: 'http://localhost:5454' } },
    requireActorContext: () => ({
      actor: { actorId: userId, actorType: 'user', roles: ['owner'] },
      tenant: { organizationId },
    }),
    requireProjectAdmin: async () => true,
    isProjectAccessibleToActor: async () => true,
  } as unknown as RouteDeps)

  await app.ready()
  return app
}

/**
 * The list route parses what it builds through `BoardSourceRecordSchema`, so a
 * field added to the contract and not to `mapBoardSource` is a 500 for every
 * caller — which is what the connections list did once. The board's Sync button
 * and its live/polling label read three of these, so they are pinned here.
 */
test('the board reads whether a sync is running and how updates arrive', async () => {
  const removals: string[] = []
  const app = await buildApp({
    removals,
    rows: [
      sourceRow({
        webhookExternalId: 'linear-webhook-1',
        lastSyncStartedAt: new Date('2026-09-06T10:00:00.000Z'),
        lastSyncCompletedAt: new Date('2026-09-06T09:00:00.000Z'),
      }),
    ],
  })
  const response = await app.inject({ method: 'GET', url: `/api/projects/${projectId}/sources` })
  assert.equal(response.statusCode, 200, response.body)
  const [record] = JSON.parse(response.body).data

  // A start with no completion after it: the sweep has claimed this source, so
  // the button says "Syncing…" instead of inviting a second press.
  assert.equal(record.lastSyncStartedAt, '2026-09-06T10:00:00.000Z')
  assert.equal(record.lastSyncCompletedAt, '2026-09-06T09:00:00.000Z')
  // Registered means the provider is calling us — the fact, not a reading of
  // what the deployment was configured with.
  assert.equal(record.webhookActive, true)
  // From the adapter's own declaration, so the label cannot claim a freshness
  // the sync does not deliver.
  assert.equal(record.pollingIntervalMinutes, 5)
  clearBoardSourceAdapters()
})

test('a source with no registration says so rather than claiming to be live', async () => {
  const app = await buildApp({ removals: [], rows: [sourceRow({ webhookExternalId: null })] })
  const response = await app.inject({ method: 'GET', url: `/api/projects/${projectId}/sources` })
  const [record] = JSON.parse(response.body).data
  assert.equal(record.webhookActive, false)
  clearBoardSourceAdapters()
})

test('removing a source takes its webhook out of the provider with it', async () => {
  const removals: string[] = []
  const app = await buildApp({
    removals,
    rows: [sourceRow({ webhookExternalId: 'linear-webhook-1' })],
  })
  const response = await app.inject({
    method: 'DELETE',
    url: `/api/projects/${projectId}/sources/${sourceId}`,
  })
  assert.equal(response.statusCode, 200, response.body)
  // Otherwise the person's Linear keeps a callback per removed source, each
  // pointed at a URL that answers 202 and drops the delivery forever.
  assert.deepEqual(removals, ['linear-webhook-1'])
  clearBoardSourceAdapters()
})

test('a source that never registered one is removed without dialling the provider', async () => {
  const removals: string[] = []
  const app = await buildApp({ removals, rows: [sourceRow({ webhookExternalId: null })] })
  const response = await app.inject({
    method: 'DELETE',
    url: `/api/projects/${projectId}/sources/${sourceId}`,
  })
  assert.equal(response.statusCode, 200, response.body)
  assert.deepEqual(removals, [])
  clearBoardSourceAdapters()
})
