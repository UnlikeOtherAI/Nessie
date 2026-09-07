import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CLOUD_BROWSER_ERROR_CODES,
  CloudBrowserError,
  type BrowserbaseClient,
} from '@nessie/browser-cloud'
import type { AgentCardSpec } from '@nessie/schemas'

import {
  AgentCardSecretPlacementError,
  resolveAgentCardSecretPlacements,
  storeAgentCardSecrets,
} from '../src/services/agent-card-secret-placement.js'
import {
  AgentCardResponseError,
  respondToAgentCard,
} from '../src/services/agent-card-response.js'

const ORGANIZATION_ID = '11111111-1111-4111-8111-111111111111'
const RESPONDER_ID = '22222222-2222-4222-8222-222222222222'
const TEAM_ID = '33333333-3333-4333-8333-333333333333'

const browserbaseSpec = (destination: Record<string, unknown>): AgentCardSpec => ({
  actions: [{ key: 'connect', label: 'Connect', style: 'primary', submits: true }],
  blocks: [{
    destination: { kind: 'browserbase_connection', scope: 'user', ...destination },
    key: 'browserbase_api_key',
    label: 'Browserbase API key',
    type: 'secret',
  }],
  schemaVersion: 1,
  title: 'Connect Browserbase',
})

const probeClient = (failure?: Error): BrowserbaseClient => ({
  createContext: async () => ({ id: 'context' }),
  createSession: async () => {
    if (failure) throw failure
    return { id: 'probe-session', status: 'RUNNING' }
  },
  deleteContext: async () => undefined,
  endSession: async () => undefined,
  liveView: async () => ({ debuggerFullscreenUrl: 'https://www.browserbase.com', pages: [] }),
})

const browserbasePrisma = (input: { teamExists?: boolean } = {}) => {
  const writes: Array<Record<string, unknown>> = []
  return {
    prisma: {
      cloudBrowserConnection: {
        create: async ({ data }: { data: Record<string, unknown> }) => {
          writes.push(data)
          return { id: 'connection-id' }
        },
        findFirst: async () => null,
      },
      team: {
        findFirst: async () => (input.teamExists === false ? null : { id: TEAM_ID }),
      },
    },
    writes,
  }
}

const resolve = async (input: {
  client: BrowserbaseClient
  isOwner?: boolean
  prisma: unknown
  scope?: Record<string, unknown>
  secrets?: Record<string, string>
  spec?: AgentCardSpec
  storeSecret: (value: string) => Promise<string>
}) =>
  resolveAgentCardSecretPlacements(input.prisma as never, {
    browserCloud: {
      clientFactory: () => input.client,
      storeSecret: async (_tx, value) => input.storeSecret(value),
    },
    isOwner: input.isOwner ?? false,
    organizationId: ORGANIZATION_ID,
    secrets: input.secrets ?? { browserbase_api_key: 'bb_secret_that_must_not_escape' },
    spec: input.spec ?? browserbaseSpec(input.scope ?? {}),
    userId: RESPONDER_ID,
  })

test('a Browserbase card key reaches only the probe/store seam and its outcome is safe', async () => {
  const { prisma, writes } = browserbasePrisma()
  const stored: string[] = []
  const placements = await resolve({
    client: probeClient(),
    prisma,
    storeSecret: async (value) => {
      stored.push(value)
      return 'secret_browserbase_ref'
    },
  })

  assert.deepEqual(placements.browserbaseConnection.map(({ apiKey: _apiKey, ...safe }) => safe), [{
    actingUserId: RESPONDER_ID,
    key: 'browserbase_api_key',
    organizationId: ORGANIZATION_ID,
    scope: 'user',
    teamId: null,
    userId: RESPONDER_ID,
  }])
  // A probe does not persist or rekey anything before the card wins its CAS.
  assert.deepEqual(stored, [])
  assert.deepEqual(writes, [])

  const outcomes = await storeAgentCardSecrets(prisma as never, {
    browserCloud: {
      storeSecret: async (_tx, value) => {
        stored.push(value)
        return 'secret_browserbase_ref'
      },
    },
    dashboardCredentials: {} as never,
    mcpSecretStore: {} as never,
    organizationId: ORGANIZATION_ID,
    placements,
    threadId: 'thread-id',
    userId: RESPONDER_ID,
  })
  assert.deepEqual(outcomes, {
    browserbase_api_key: { kind: 'browserbase_connection', scope: 'user' },
  })
  assert.deepEqual(stored, ['bb_secret_that_must_not_escape'])
  assert.equal(writes[0]?.apiKeyRef, 'secret_browserbase_ref')
  assert.equal(writes[0]?.userId, RESPONDER_ID)
  assert.equal(JSON.stringify(outcomes).includes('secret_browserbase_ref'), false)
})

test('an invalid Browserbase key leaves the card retryable and is never stored', async () => {
  const { prisma } = browserbasePrisma()
  let storeCalls = 0
  await assert.rejects(
    resolve({
      client: probeClient(new CloudBrowserError(
        CLOUD_BROWSER_ERROR_CODES.AUTH_FAILED,
        'Browserbase rejected this key.',
      )),
      prisma,
      storeSecret: async () => {
        storeCalls += 1
        return 'must-not-store'
      },
    }),
    (error: unknown) => error instanceof AgentCardSecretPlacementError
      && error.code === CLOUD_BROWSER_ERROR_CODES.AUTH_FAILED,
  )
  assert.equal(storeCalls, 0)

  await resolve({
    client: probeClient(),
    prisma,
    storeSecret: async () => 'secret_browserbase_retry',
  })
})

test('a later secret refusal cannot persist a Browserbase key that already probed', async () => {
  const { prisma, writes } = browserbasePrisma()
  let storeCalls = 0
  const spec = browserbaseSpec({})
  spec.blocks.push({
    destination: { kind: 'browserbase_connection', scope: 'organization' },
    key: 'shared_browserbase_api_key',
    label: 'Organisation Browserbase API key',
    type: 'secret',
  })

  await assert.rejects(
    resolve({
      client: probeClient(),
      prisma,
      secrets: {
        browserbase_api_key: 'bb_secret_that_must_not_escape',
        shared_browserbase_api_key: 'bb_second_secret_that_must_not_escape',
      },
      spec,
      storeSecret: async () => {
        storeCalls += 1
        return 'must-not-store'
      },
    }),
    (error: unknown) => error instanceof AgentCardSecretPlacementError
      && error.code === 'CARD_SECRET_REFUSED',
  )
  assert.equal(storeCalls, 0)
  assert.deepEqual(writes, [])
})

test('a shared Browserbase account mirrors the owner and team scope gates', async () => {
  const { prisma, writes } = browserbasePrisma()
  await assert.rejects(
    resolve({
      client: probeClient(),
      prisma,
      scope: { scope: 'team', teamId: TEAM_ID },
      storeSecret: async () => 'must-not-store',
    }),
    (error: unknown) => error instanceof AgentCardSecretPlacementError
      && error.code === 'CARD_SECRET_REFUSED',
  )

  const placements = await resolve({
    client: probeClient(),
    isOwner: true,
    prisma,
    scope: { scope: 'team', teamId: TEAM_ID },
    storeSecret: async () => 'secret_browserbase_team',
  })
  assert.deepEqual(placements.browserbaseConnection.map(({ apiKey: _apiKey, ...safe }) => safe), [{
    actingUserId: RESPONDER_ID,
    key: 'browserbase_api_key',
    organizationId: ORGANIZATION_ID,
    scope: 'team',
    teamId: TEAM_ID,
    userId: null,
  }])
  assert.deepEqual(writes, [])
})

test('a losing card claim cannot persist a Browserbase key that already probed', async () => {
  let claimCalls = 0
  const connectionWrites: unknown[] = []
  const prisma = {
    $transaction: async <T>(callback: (tx: unknown) => Promise<T>) => callback({
      agentCard: {
        updateMany: async () => {
          claimCalls += 1
          return { count: 0 }
        },
      },
      cloudBrowserConnection: {
        create: async (input: unknown) => {
          connectionWrites.push(input)
          return { id: 'must-not-create' }
        },
        findFirst: async () => null,
      },
    }),
  }
  const card = {
    browserLogin: null,
    expiresAt: null,
    id: 'card-id',
    message: { basisScopes: [], rootMessageId: null },
    messageId: 'message-id',
    organizationId: ORGANIZATION_ID,
    respondentUserIds: [],
    spec: browserbaseSpec({}),
    threadId: 'thread-id',
  }

  await assert.rejects(
    respondToAgentCard({
      browserCloudClientFactory: () => probeClient(),
      buildChannelRealtimeScopes: () => [] as never,
      dashboardCredentials: {} as never,
      mcpSecretStore: {} as never,
      prisma: prisma as never,
      realtimeHub: {} as never,
    }, {
      actionKey: 'connect',
      actorContext: {
        actor: { actorId: RESPONDER_ID, roles: ['member'] },
        tenant: { organizationId: ORGANIZATION_ID },
      } as never,
      card: card as never,
      secrets: { browserbase_api_key: 'bb_secret_that_must_not_escape' },
    }),
    (error: unknown) => error instanceof AgentCardResponseError
      && error.code === 'CARD_NOT_OPEN',
  )

  assert.equal(claimCalls, 1)
  assert.deepEqual(connectionWrites, [])
})
