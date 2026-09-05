import assert from 'node:assert/strict'
import test from 'node:test'

import type { RealtimeNotificationPayload, WsEventMessage } from '@nessie/runtime'
import type { WsScope } from '@nessie/schemas'

import {
  createWsNotificationDelivery,
  type ThreadSseConnection,
} from '../src/realtime/notification-delivery.js'
import { REALTIME_ENTITLEMENT_TTL_MS } from '../src/realtime/delivery-entitlements.js'

/**
 * Revocation on an open connection.
 *
 * A socket is one request, so `authenticateRequest`'s "revocation takes effect
 * on the next request" promise expires the moment the stream opens. Channel and
 * dashboard scopes were already re-asked per delivery; thread streams,
 * organization scopes and agent scopes were authorized once at subscribe time
 * and never again. Each case below revokes access on a live connection and
 * asserts the very next event does not arrive.
 */

const ORGANIZATION_ID = '40000000-0000-4000-8000-000000000001'
const OTHER_ORGANIZATION_ID = '40000000-0000-4000-8000-000000000002'
const USER_ID = '40000000-0000-4000-8000-000000000003'
const CHANNEL_ID = '40000000-0000-4000-8000-000000000004'
const THREAD_ID = '40000000-0000-4000-8000-000000000005'
const AGENT_ID = '40000000-0000-4000-8000-000000000006'

const wsMessage: WsEventMessage = {
  data: {},
  event: 'agent.updated',
  ts: new Date(0).toISOString(),
  type: 'event',
}

const threadEvent = (sequence: number): RealtimeNotificationPayload => ({
  data: { text: 'chunk' },
  event: 'stream.delta',
  kind: 'sse',
  sequence,
  threadId: THREAD_ID,
} as unknown as RealtimeNotificationPayload)

const createClock = () => {
  let value = 1_000
  return {
    now: () => value,
    advancePastTtl: () => {
      value += REALTIME_ENTITLEMENT_TTL_MS + 1
    },
  }
}

const createThreadConnection = (written: string[]): ThreadSseConnection => ({
  kind: 'thread',
  channelId: null,
  hydrating: false,
  lastSequence: 0,
  pending: [],
  response: {
    once: () => undefined,
    write: (chunk: string) => {
      written.push(chunk)
      return true
    },
  },
  saturated: false,
  threadId: THREAD_ID,
  viewer: { organizationId: ORGANIZATION_ID, userId: USER_ID },
})

test('a revoked channel member stops receiving that thread stream on the next event', async () => {
  const clock = createClock()
  let channelAccess = true
  let channelChecks = 0
  let threadResolutions = 0
  const { deliverNotification, threadSseConnections } = createWsNotificationDelivery({
    canAccessChannelEvent: async (request) => {
      channelChecks += 1
      assert.equal(request.channelId, CHANNEL_ID)
      assert.equal(request.userId, USER_ID)
      return channelAccess
    },
    entitlements: {
      resolveThreadChannelId: async (threadId) => {
        threadResolutions += 1
        assert.equal(threadId, THREAD_ID)
        return CHANNEL_ID
      },
    },
    now: clock.now,
  })

  const written: string[] = []
  threadSseConnections.add(createThreadConnection(written))

  await deliverNotification(threadEvent(1))
  assert.equal(written.length, 1, 'a member receives the stream')

  // A token-by-token burst inside one TTL window costs a single membership
  // query, which is what makes a per-event check affordable on this lane.
  await deliverNotification(threadEvent(2))
  await deliverNotification(threadEvent(3))
  assert.equal(written.length, 3)
  assert.equal(channelChecks, 1, 'the burst collapses into one entitlement query')

  // Removed from the private channel mid-stream.
  channelAccess = false
  clock.advancePastTtl()

  await deliverNotification(threadEvent(4))
  assert.equal(written.length, 3, 'delivery stops on the next event, not at reconnect')
  assert.equal(channelChecks, 2)
  assert.equal(threadResolutions, 1, 'a thread does not change channels — resolved once')
})

test('an organization scope is re-checked at delivery, not only at subscribe', async () => {
  const clock = createClock()
  let membershipActive = true
  const scopes: WsScope[] = [
    { kind: 'organization', organizationId: ORGANIZATION_ID } as WsScope,
  ]
  const { deliverNotification, wsConnections } = createWsNotificationDelivery({
    entitlements: {
      canAccessOrganizationEvent: async (request) => {
        assert.equal(request.organizationId, ORGANIZATION_ID)
        assert.equal(request.userId, USER_ID)
        return membershipActive
      },
    },
    now: clock.now,
  })

  const sent: WsEventMessage[] = []
  wsConnections.add({
    organizationId: ORGANIZATION_ID,
    scopes,
    send: (message) => sent.push(message),
    userId: USER_ID,
  })

  await deliverNotification({ kind: 'ws', message: wsMessage, scopes })
  assert.equal(sent.length, 1)

  // Deactivating a membership revokes refresh families and auth sessions but
  // closes no socket; this check is what ends the feed.
  membershipActive = false
  clock.advancePastTtl()

  await deliverNotification({ kind: 'ws', message: wsMessage, scopes })
  assert.equal(sent.length, 1, 'a deactivated member stops receiving org-scoped events')
})

test('an agent scope is re-checked against agent visibility at delivery', async () => {
  const clock = createClock()
  let visible = true
  const scopes: WsScope[] = [{ kind: 'agent', agentId: AGENT_ID } as WsScope]
  const { deliverNotification, wsConnections } = createWsNotificationDelivery({
    entitlements: {
      canAccessAgentEvent: async (request) => {
        assert.equal(request.agentId, AGENT_ID)
        assert.equal(request.organizationId, ORGANIZATION_ID)
        return visible
      },
    },
    now: clock.now,
  })

  const sent: WsEventMessage[] = []
  wsConnections.add({
    organizationId: ORGANIZATION_ID,
    scopes,
    send: (message) => sent.push(message),
    userId: USER_ID,
  })

  await deliverNotification({ kind: 'ws', message: wsMessage, scopes })
  assert.equal(sent.length, 1)

  visible = false
  clock.advancePastTtl()

  await deliverNotification({ kind: 'ws', message: wsMessage, scopes })
  assert.equal(sent.length, 1, 'an agent that stopped being visible stops streaming')
})

test('an organization scope from another tenant never delivers', async () => {
  const { deliverNotification, wsConnections } = createWsNotificationDelivery({
    entitlements: {
      canAccessOrganizationEvent: async () => true,
    },
  })

  const sent: WsEventMessage[] = []
  wsConnections.add({
    organizationId: ORGANIZATION_ID,
    scopes: [{ kind: 'organization', organizationId: ORGANIZATION_ID } as WsScope],
    send: (message) => sent.push(message),
    userId: USER_ID,
  })

  await deliverNotification({
    kind: 'ws',
    message: wsMessage,
    scopes: [{ kind: 'organization', organizationId: OTHER_ORGANIZATION_ID } as WsScope],
  })

  assert.equal(sent.length, 0)
})
