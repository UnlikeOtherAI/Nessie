import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'
import type { AppConnectContext } from '@nessie/mcp-manage'
import type { AuthorizedActionContext } from '@nessie/schemas'

import {
  AppConnectionRequestActionError,
  beginAppConnectionRequest,
} from '../src/services/app-connection-request-actions.js'

const organizationId = '00000000-0000-4000-8000-000000000001'
const userId = '00000000-0000-4000-8000-000000000002'
const agentId = '00000000-0000-4000-8000-000000000003'
const channelId = '00000000-0000-4000-8000-000000000004'
const requestId = '00000000-0000-4000-8000-000000000005'
const appId = '00000000-0000-4000-8000-000000000006'
const connectionId = '00000000-0000-4000-8000-000000000007'

const actorContext: AuthorizedActionContext = {
  actionContext: { requestId: 'request-1' },
  actor: { actorId: userId, actorType: 'user', roles: ['member'] },
  tenant: { organizationId },
} as unknown as AuthorizedActionContext

const makeRow = () => ({
  agent: {
    agentKind: 'personal_assistant',
    bindings: [{ channelId }],
    id: agentId,
    systemManaged: true,
    toolPolicy: {},
  },
  agentId,
  candidateCatalogEntryIds: [appId],
  consentSnapshot: {
    agent: { id: agentId, name: 'Personal Assistant' },
    candidates: [{
      authMethod: 'oauth2',
      capabilityCount: 67,
      catalogEntryId: appId,
      displayName: 'Linear',
      iconUrl: null,
      shortDescription: 'Project planning and issue tracking',
      trustLevel: 'verified',
    }],
    scope: { label: 'Only you', scopeId: userId, scopeType: 'user' },
  },
  expiresAt: new Date('2030-01-01T00:00:00.000Z'),
  failureCode: null,
  id: requestId,
  mcpInstance: null,
  requestedByUser: { organizationMembers: [{ id: 'membership' }] },
  selectedCatalogEntryId: null as string | null,
  status: 'offered' as 'offered' | 'connecting',
  thread: {
    channel: {
      dmKey: `pa:${organizationId}:${userId}`,
      id: channelId,
      members: [{ userId }],
      systemChannelType: 'personal_assistant',
    },
  },
})

const makePrisma = (claimWins: boolean, catalogStillVisible = true) => {
  const row = makeRow()
  const updates: Array<Record<string, unknown>> = []
  const tx = {
    $executeRaw: async () => 0,
    agentAppConnectionRequest: {
      findFirst: async ({ where }: { where: { requestedByUserId: string } }) =>
        where.requestedByUserId === userId ? row : null,
      updateMany: async ({ data }: { data: Record<string, unknown> }) => {
        updates.push(data)
        if ('selectedCatalogEntryId' in data) {
          if (!claimWins) return { count: 0 }
          row.selectedCatalogEntryId = appId
          row.status = 'connecting'
          return { count: 1 }
        }
        return { count: 1 }
      },
    },
    mcpCatalogEntry: {
      findFirst: async () => catalogStillVisible ? { id: appId } : null,
    },
    toolGrant: { findMany: async () => [] },
  }
  const prisma = {
    $transaction: async <T>(action: (client: typeof tx) => Promise<T>) => action(tx),
    ...tx,
  } as unknown as PrismaClient
  return { prisma, row, updates }
}

test('begin claims one candidate before returning its immediate-only OAuth URL', async () => {
  const state = makePrisma(true)
  let connectCalls = 0

  const result = await beginAppConnectionRequest(
    state.prisma,
    actorContext,
    requestId,
    appId,
    {} as AppConnectContext,
    (async () => {
      connectCalls += 1
      return {
        app: {} as never,
        outcome: {
          authorizationUrl: 'https://linear.app/oauth/authorize?state=one-time',
          connectionId,
          status: 'authorize' as const,
        },
      }
    }) as never,
  )

  assert.deepEqual(result, {
    authorizationUrl: 'https://linear.app/oauth/authorize?state=one-time',
    status: 'authorize',
  })
  assert.equal(connectCalls, 1)
  assert.equal(state.row.selectedCatalogEntryId, appId)
  assert.equal(state.row.status, 'connecting')
  assert.deepEqual(state.updates, [
    { scopeId: userId, scopeType: 'user', selectedCatalogEntryId: appId, status: 'connecting' },
    { connectionBackend: 'mcp', mcpInstanceId: connectionId, status: 'connecting' },
  ])
})

test('a competing click cannot start another provider flow', async () => {
  const state = makePrisma(false)
  let connectCalls = 0

  await assert.rejects(
    beginAppConnectionRequest(
      state.prisma,
      actorContext,
      requestId,
      appId,
      {} as AppConnectContext,
      (async () => {
        connectCalls += 1
        return { app: {} as never, outcome: { connectionId, status: 'connected' as const } }
      }) as never,
    ),
    (error: unknown) => error instanceof AppConnectionRequestActionError,
  )
  assert.equal(connectCalls, 0)
})

test('a card cannot connect an app that became unavailable after it was offered', async () => {
  const state = makePrisma(true, false)
  let connectCalls = 0

  await assert.rejects(
    beginAppConnectionRequest(
      state.prisma,
      actorContext,
      requestId,
      appId,
      {} as AppConnectContext,
      (async () => {
        connectCalls += 1
        return { app: {} as never, outcome: { connectionId, status: 'connected' as const } }
      }) as never,
    ),
    (error: unknown) => error instanceof AppConnectionRequestActionError,
  )

  assert.equal(connectCalls, 0)
  assert.deepEqual(state.updates, [])
})
