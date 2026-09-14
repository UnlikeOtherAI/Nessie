import assert from 'node:assert/strict'
import test from 'node:test'

import type { McpToolDescriptor } from '@nessie/mcp-client'

import {
  APP_CONNECT_ERROR_CODES,
  AppConnectError,
  disconnectAppConnection,
  reconnectAppConnection,
  refreshAppConnectionCapabilities,
} from '../src/apps/app-connect.js'
import { presentAppConnection } from '../src/apps/app-connections.js'
import {
  MEMBER,
  ORG,
  OTHER,
  actor,
  catalogEntry,
  instanceRow,
  makeAppConnectStub,
} from './app-connect-test-support.js'

const oauthEntry = () => catalogEntry({
  authMethod: 'oauth2',
  authConfig: {
    method: 'oauth2',
    authorizationUrl: 'https://93.184.216.34/authorize',
    tokenUrl: 'https://93.184.216.34/token',
    clientId: 'nessie-test-client',
    scopes: [],
  },
})

test("reconnect refuses an account scoped to somebody else's identity", async () => {
  const { ctx } = makeAppConnectStub({ instance: instanceRow({ scopeType: 'user', scopeId: OTHER }) })
  await assert.rejects(
    reconnectAppConnection(ctx, 'instance-1'),
    (error: unknown) =>
      error instanceof AppConnectError
      && error.code === APP_CONNECT_ERROR_CODES.CONNECT_FORBIDDEN,
  )
})

test('expired OAuth recovery reauthorizes the selected account without a duplicate', async () => {
  const existing = instanceRow({ scopeType: 'user', scopeId: MEMBER })
  const { ctx, created } = makeAppConnectStub({
    credentialRef: 'secret_stale_oauth_grant',
    entry: oauthEntry(),
    instance: existing,
    instanceAtScope: existing,
  })

  const outcome = await reconnectAppConnection(ctx, existing.id)
  assert.equal(outcome.status, 'authorize')
  assert.equal(outcome.connectionId, existing.id)
  assert.equal(created.length, 0)
})

test('the account row carries each recovery permission without treating visibility as authority', () => {
  const connection = presentAppConnection(
    instanceRow(),
    'Acme',
    {
      canDisconnect: false,
      canReconnect: true,
      canRefreshCapabilities: false,
    },
  )
  assert.equal(connection.canReconnect, true)
  assert.equal(connection.canRefreshCapabilities, false)
  assert.equal(connection.canDisconnect, false)
})

test('refreshing capabilities reports what the server offers now', async () => {
  const { ctx } = makeAppConnectStub({
    probe: {
      descriptors: [
        { name: 'search', description: '' } as McpToolDescriptor,
        { name: 'create', description: '' } as McpToolDescriptor,
      ],
    },
  })
  const result = await refreshAppConnectionCapabilities(ctx, 'instance-1')
  assert.equal(result.connectionId, 'instance-1')
  assert.equal(result.status, 'connected')
  assert.equal(result.toolCount, 2)
})

test('refresh preserves the existing app connection\'s explicit-grant boundary', async () => {
  const protectedInstance = instanceRow({ requiresExplicitToolGrant: true })
  const { connection, ctx } = makeAppConnectStub({
    instance: protectedInstance,
    probe: { descriptors: [{ name: 'search', description: '' } as McpToolDescriptor] },
  })

  await refreshAppConnectionCapabilities(ctx, protectedInstance.id)
  assert.equal(connection()?.requiresExplicitToolGrant, true)
})

test('refreshing a shared connection requires its manager even when it is visible', async () => {
  const shared = instanceRow({ scopeType: 'organization', scopeId: ORG })
  const { ctx } = makeAppConnectStub({ instance: shared })
  await assert.rejects(
    refreshAppConnectionCapabilities(ctx, shared.id),
    (error: unknown) =>
      error instanceof AppConnectError
      && error.code === APP_CONNECT_ERROR_CODES.CONNECT_FORBIDDEN,
  )
})

test('refreshing an unreachable connection answers rather than throwing', async () => {
  const { ctx } = makeAppConnectStub({ probe: { failWith: 'boom' } })
  const result = await refreshAppConnectionCapabilities(ctx, 'instance-1')
  assert.equal(result.status, 'error')
  assert.equal(result.toolCount, 0)
})

test('disconnecting needs the scope manage right, not merely reach', async () => {
  const shared = instanceRow({ scopeType: 'organization', scopeId: ORG })
  const { ctx, deleted } = makeAppConnectStub({ instance: shared })
  await assert.rejects(
    disconnectAppConnection(ctx, 'instance-1'),
    (error: unknown) =>
      error instanceof AppConnectError
      && error.code === APP_CONNECT_ERROR_CODES.CONNECT_FORBIDDEN,
  )
  assert.equal(deleted.length, 0)
})

test('disconnecting reads the live membership rather than a stale actor role', async () => {
  const shared = instanceRow({ scopeType: 'organization', scopeId: ORG })
  const { ctx, deleted } = makeAppConnectStub({ instance: shared })
  ctx.actorContext = actor(MEMBER, ['owner'])

  await assert.rejects(
    disconnectAppConnection(ctx, 'instance-1'),
    (error: unknown) =>
      error instanceof AppConnectError
      && error.code === APP_CONNECT_ERROR_CODES.CONNECT_FORBIDDEN,
  )
  assert.equal(deleted.length, 0)
})

test('disconnecting reports the app and scope it removed, for the audit trail', async () => {
  const { ctx, deleted } = makeAppConnectStub()
  const removed = await disconnectAppConnection(ctx, 'instance-1')
  assert.deepEqual(removed, {
    connectionId: 'instance-1',
    catalogEntryId: 'entry-1',
    scopeType: 'user',
    scopeId: MEMBER,
  })
  assert.deepEqual(deleted, ['instance-1'])
})

test('a connection that is not this organisation’s is simply not found', async () => {
  const { ctx } = makeAppConnectStub({ instance: null })
  await assert.rejects(
    disconnectAppConnection(ctx, 'instance-1'),
    (error: unknown) =>
      error instanceof AppConnectError
      && error.code === APP_CONNECT_ERROR_CODES.CONNECTION_NOT_FOUND,
  )
})
