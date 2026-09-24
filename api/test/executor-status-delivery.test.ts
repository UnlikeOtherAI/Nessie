import type { FastifyBaseLogger } from 'fastify'
import type { RouteDeps } from '../src/routes/types.js'
import { notifyExecutorStatus } from '../src/routes/executor-status-events.js'
import assert from 'node:assert/strict'
import test from 'node:test'
import { parseOrganizationId } from '@nessie/schemas'
import type { WsEventMessage } from '@nessie/runtime'
import { createWsNotificationDelivery } from '../src/realtime/notification-delivery.js'

const organizationId = parseOrganizationId('22222222-2222-4222-8222-222222222222')
const scopes = [{ kind: 'executor_inventory' as const, organizationId }]
const message: WsEventMessage = {
  type: 'event', event: 'executor.status.changed', ts: '2026-09-24T00:00:00.000Z',
  data: { executorId: '33333333-3333-4333-8333-333333333333', status: 'online',
    statusDetail: null, lastSeenAt: null, updatedAt: '2026-09-24T00:00:00.000Z', removed: false },
}

test('executor presence reaches only current readers on WS and SSE; unknown scopes fail closed', async () => {
  let allowed = true
  const delivery = createWsNotificationDelivery({ entitlements: {
    canAccessExecutorEvent: async ({ userId }) => allowed && userId === 'owner',
    canAccessOrganizationEvent: async () => true,
  } })
  const sent = new Map<string, unknown[]>()
  for (const userId of ['owner', 'unassigned', 'old-client']) {
    const output: unknown[] = []
    sent.set(userId, output)
    const connectionScopes = userId === 'old-client' ? [{ kind: 'organization' as const, organizationId }] : scopes
    delivery.wsConnections.add({ organizationId, userId, scopes: connectionScopes,
      close: () => undefined, send: (event) => { output.push(event) } })
    delivery.userSseConnections.add({ kind: 'user', organizationId, userId, scopes: connectionScopes,
      channelIds: new Set(), hydrating: false, lastEventId: 0n, pending: [],
      response: { once: () => undefined, write: (event) => { output.push(event); return true } },
    })
  }
  await delivery.deliverNotification({ kind: 'ws', scopes, message })
  assert.equal(sent.get('owner')?.length, 2)
  assert.equal(sent.get('unassigned')?.length, 0)
  assert.equal(sent.get('old-client')?.length, 0)
  allowed = false
  await delivery.deliverNotification({ kind: 'ws', scopes, message })
  assert.equal(sent.get('owner')?.length, 2, 'revocation takes effect on the very next status')
})

test('a hub missing the executor entitlement predicate never sends presence', async () => {
  const delivery = createWsNotificationDelivery({})
  delivery.wsConnections.add({ organizationId, userId: 'owner', scopes,
    close: () => undefined, send: () => assert.fail('missing predicate must fail closed') })
  await delivery.deliverNotification({ kind: 'ws', scopes, message })
})

test('malformed status data is discarded before entitlement lookup or delivery', async () => {
  const delivery = createWsNotificationDelivery({ entitlements: {
    canAccessExecutorEvent: async () => assert.fail('invalid payload must not query access'),
  } })
  delivery.wsConnections.add({ organizationId, userId: 'owner', scopes,
    close: () => undefined, send: () => assert.fail('invalid payload must not be sent') })
  await delivery.deliverNotification({ kind: 'ws', scopes, message: { ...message, data: {} } })
})

test('a failed inventory announcement does not reject an already committed access change', async () => {
  let calls = 0
  let warnings = 0
  const deps = {
    prisma: { executor: { findUnique: async () => ({
      id: '33333333-3333-4333-8333-333333333333', organizationId, status: 'paused',
      lastSeenAt: null, statusDetail: null, updatedAt: new Date(), removedAt: null,
    }) } },
    realtimeHub: { publishWs: async () => {
      calls += 1
      if (calls === 2) throw new Error('notification transport unavailable')
    } },
  } as unknown as RouteDeps
  const log = { warn: () => { warnings += 1 } } as unknown as FastifyBaseLogger
  await notifyExecutorStatus(deps, log, '33333333-3333-4333-8333-333333333333', organizationId)
  assert.equal(calls, 2)
  assert.equal(warnings, 1)
})
