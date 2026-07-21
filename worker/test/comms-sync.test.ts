import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import type { PrismaClient } from '@prisma/client'
import {
  clearConnectors,
  registerConnector,
  sealSecret,
  SyncCursorExpiredError,
  type CommunicationsConnector,
  type ConnectorConnectionContext,
  type CredentialBundle,
  type Resource,
  type SubscriptionDescriptor,
  type SyncResult,
} from '@nessie/comms-connect'
import { executeCommsIncrementalSyncJob } from '../src/control/comms-sync.js'

const ENCRYPTION_SECRET = 'test-comms-secret'
const CONNECTION_ID = '11111111-1111-1111-1111-111111111111'
const JOB_ID = '22222222-2222-2222-2222-222222222222'
const DAY_MS = 24 * 60 * 60 * 1000

type JobRow = {
  id: string
  connectionId: string
  resourceId: string | null
  phase: 'history' | 'incremental' | 'reconciliation'
  cursor: string | null
  oldestImportedAt: Date | null
  newestImportedAt: Date | null
  status: 'pending' | 'running' | 'completed' | 'failed'
  retryCount: number
  lastError: string | null
  createdAt: Date
}

type ConnectionRow = {
  id: string
  organizationId: string
  ownerUserId: string
  provider: 'slack' | 'google' | 'microsoft'
  externalTenantId: string
  externalUserId: string
  status: 'active' | 'needs_reauthorization' | 'disconnected' | 'error'
  grantedScopes: string[]
  initialSyncCompletedAt: Date | null
  lastSuccessfulSyncAt: Date | null
  credential: {
    accessTokenCiphertext: string
    refreshTokenCiphertext: string | null
    expiresAt: Date | null
  }
}

type FakeState = { connection: ConnectionRow; job: JobRow }

const makeConnection = (lastSyncAt: Date | null): ConnectionRow => ({
  id: CONNECTION_ID,
  organizationId: '33333333-3333-3333-3333-333333333333',
  ownerUserId: '44444444-4444-4444-4444-444444444444',
  provider: 'slack',
  externalTenantId: 'T1',
  externalUserId: 'U1',
  status: 'active',
  grantedScopes: ['channels:history'],
  initialSyncCompletedAt: new Date(),
  lastSuccessfulSyncAt: lastSyncAt,
  credential: {
    accessTokenCiphertext: sealSecret(ENCRYPTION_SECRET, 'access-token'),
    refreshTokenCiphertext: sealSecret(ENCRYPTION_SECRET, 'refresh-token'),
    expiresAt: null,
  },
})

const makeState = (lastSyncAt: Date | null): FakeState => ({
  connection: makeConnection(lastSyncAt),
  job: {
    id: JOB_ID,
    connectionId: CONNECTION_ID,
    resourceId: null,
    phase: 'incremental',
    cursor: 'stale-cursor',
    oldestImportedAt: null,
    newestImportedAt: null,
    status: 'pending',
    retryCount: 0,
    lastError: null,
    createdAt: new Date(),
  },
})

const makeFakePrisma = (state: FakeState): PrismaClient =>
  ({
    commsConnection: {
      findUnique: () => Promise.resolve(state.connection),
      update: ({ data }: { data: Partial<ConnectionRow> }) => {
        Object.assign(state.connection, data)
        return Promise.resolve(state.connection)
      },
    },
    commsSyncJob: {
      findFirst: () => Promise.resolve(state.job),
      create: ({ data }: { data: Partial<JobRow> }) => {
        Object.assign(state.job, data)
        return Promise.resolve(state.job)
      },
      update: ({ data }: { data: Partial<JobRow> & { retryCount?: unknown } }) => {
        const patch: Partial<JobRow> = { ...(data as Partial<JobRow>) }
        const rc = data.retryCount
        if (rc && typeof rc === 'object' && 'increment' in rc) {
          patch.retryCount =
            state.job.retryCount + (rc as { increment: number }).increment
        }
        Object.assign(state.job, patch)
        return Promise.resolve(state.job)
      },
    },
  }) as unknown as PrismaClient

/** A connector whose incremental sync always throws the supplied error. */
const throwingConnector = (error: unknown): CommunicationsConnector => ({
  provider: 'slack',
  connect: () => Promise.reject(error),
  refreshCredentials: (): Promise<CredentialBundle> => Promise.reject(error),
  discoverResources: (): Promise<Resource[]> => Promise.resolve([]),
  runInitialSync: (): Promise<SyncResult> => Promise.reject(error),
  runIncrementalSync: (
    _connection: ConnectorConnectionContext,
  ): Promise<SyncResult> => Promise.reject(error),
  processWebhook: () => Promise.resolve([]),
  renewSubscriptions: (): Promise<SubscriptionDescriptor[]> =>
    Promise.resolve([]),
  disconnect: () => Promise.resolve(),
})

afterEach(() => {
  clearConnectors()
})

test('SyncCursorExpiredError resets the job to a bounded history re-sync', async () => {
  const lastSyncAt = new Date('2026-07-01T00:00:00.000Z')
  const state = makeState(lastSyncAt)
  registerConnector('slack', () =>
    throwingConnector(new SyncCursorExpiredError()),
  )

  // Must not rethrow: the queue should not retry a dead cursor.
  await executeCommsIncrementalSyncJob(
    { prisma: makeFakePrisma(state), encryptionSecret: ENCRYPTION_SECRET },
    { connectionId: CONNECTION_ID },
  )

  assert.equal(state.job.status, 'pending')
  assert.equal(state.job.phase, 'history')
  assert.equal(state.job.cursor, null)
  assert.equal(state.job.newestImportedAt, null)
  // Seeded from lastSuccessfulSyncAt minus a 1-day overlap.
  assert.equal(
    state.job.oldestImportedAt?.getTime(),
    lastSyncAt.getTime() - DAY_MS,
  )
  // The connection is untouched — the credential is still valid.
  assert.equal(state.connection.status, 'active')
})

test('SyncCursorExpiredError with no prior sync seeds a null window', async () => {
  const state = makeState(null)
  registerConnector('slack', () =>
    throwingConnector(new SyncCursorExpiredError()),
  )

  await executeCommsIncrementalSyncJob(
    { prisma: makeFakePrisma(state), encryptionSecret: ENCRYPTION_SECRET },
    { connectionId: CONNECTION_ID },
  )

  assert.equal(state.job.status, 'pending')
  assert.equal(state.job.phase, 'history')
  assert.equal(state.job.oldestImportedAt, null)
})

test('needsReauthorization parks the connection and fails without retry', async () => {
  const state = makeState(new Date())
  const reauthError = Object.assign(new Error('token_revoked'), {
    needsReauthorization: true,
  })
  registerConnector('slack', () => throwingConnector(reauthError))

  // Must not rethrow: retrying dead credentials is pointless.
  await executeCommsIncrementalSyncJob(
    { prisma: makeFakePrisma(state), encryptionSecret: ENCRYPTION_SECRET },
    { connectionId: CONNECTION_ID },
  )

  assert.equal(state.connection.status, 'needs_reauthorization')
  assert.equal(state.job.status, 'failed')
  assert.match(state.job.lastError ?? '', /reauthorization required/i)
})

test('an ordinary error still fails the job and rethrows for queue retry', async () => {
  const state = makeState(new Date())
  registerConnector('slack', () =>
    throwingConnector(new Error('transient network blip')),
  )

  await assert.rejects(
    executeCommsIncrementalSyncJob(
      { prisma: makeFakePrisma(state), encryptionSecret: ENCRYPTION_SECRET },
      { connectionId: CONNECTION_ID },
    ),
    /transient network blip/,
  )

  assert.equal(state.job.status, 'failed')
  assert.equal(state.job.retryCount, 1)
  assert.equal(state.connection.status, 'active')
})
