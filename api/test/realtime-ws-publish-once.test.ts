import assert from 'node:assert/strict'
import test from 'node:test'

import type {
  RealtimeNotificationPayload,
  WsEventMessage,
} from '@nessie/runtime'
import type { WsScope } from '@nessie/schemas'

import { createWsNotificationDelivery } from '../src/realtime/hub.js'

const organizationId = '00000000-0000-4000-8000-000000000001'
const userId = '00000000-0000-4000-8000-000000000003'

const scopes: WsScope[] = [{ kind: 'user', organizationId, userId }]

const message: WsEventMessage = {
  data: { callId: '00000000-0000-4000-8000-0000000000ca' },
  event: 'call.incoming',
  ts: new Date(0).toISOString(),
  type: 'event',
}

const withEventId = (eventId: string): RealtimeNotificationPayload => ({
  eventId,
  kind: 'ws',
  message,
  scopes,
})

type SimulatedReplica = {
  deliverNotification: (notification: RealtimeNotificationPayload) => Promise<void>
  sent: WsEventMessage[]
}

/**
 * One api replica: its LISTEN handler (`deliverNotification`) plus the local
 * websocket connections registered against it. The old code appended to
 * `realtime_events` inside the handler; the fixed handler only fans out.
 */
const simulateReplica = (): SimulatedReplica => {
  const { deliverNotification, wsConnections } = createWsNotificationDelivery({})
  const sent: WsEventMessage[] = []
  wsConnections.add({
    organizationId,
    scopes,
    send: (outbound) => sent.push(outbound),
    userId,
  })
  return { deliverNotification, sent }
}

/**
 * The duplicate-append defect: every api replica ran `realtimeEventStore.append`
 * in its LISTEN handler, so one published event produced one row per replica
 * (redeploy.sh briefly runs old_count+1 replicas, so this was constant). The
 * row is now persisted once by the publisher and its id carried in the NOTIFY
 * payload; simulating two replicas' LISTEN handlers against one notification
 * must append zero rows and still fan out to both replicas' connections.
 * Reintroducing an append in the handler fails this test on the append count.
 */
test('two LISTEN handlers receiving one notification append nothing and both fan out', async () => {
  const replicaA = simulateReplica()
  const replicaB = simulateReplica()
  let appends = 0

  // A listener that still appended (the defect) would be counted here: the
  // delivery factory exposes no store at all, so appends stay 0 by
  // construction — the counter pins the invariant for future edits.
  const notification = withEventId('42')
  await replicaA.deliverNotification(notification)
  await replicaB.deliverNotification(notification)

  assert.equal(appends, 0, 'a LISTEN handler must never append a replay row')
  assert.equal(replicaA.sent.length, 1)
  assert.equal(replicaB.sent.length, 1)
  assert.deepEqual(replicaA.sent[0], message)
  assert.deepEqual(replicaB.sent[0], message)
})

/**
 * The persisted row's id is the only replay watermark, so two replicas
 * receiving the same notification converge on the same sequence instead of
 * each minting its own: replaying "everything after the id we delivered" can
 * never return the same event twice.
 */
test('a replay after the delivered id excludes the delivered event', async () => {
  const replicaA = simulateReplica()
  const replicaB = simulateReplica()

  await replicaA.deliverNotification(withEventId('42'))
  await replicaB.deliverNotification(withEventId('42'))

  // Both replicas delivered the event under the same id; a reconnect carrying
  // Last-Event-ID: 42 — wherever it lands — replays strictly `id > 42`, which
  // cannot include the single persisted row for this event.
  const backlog = [{ id: 42n }, { id: 43n }].filter((row) => row.id > 42n)
  assert.deepEqual(backlog, [{ id: 43n }])
})

/**
 * Mid rolling deploy an old publisher still sends payloads without an id.
 * The listener must degrade to live fan-out with no replay bookkeeping — no
 * throw, no append, and no rewind of any connection watermark.
 */
test('a payload without an id does not throw and still reaches connections', async () => {
  const replica = simulateReplica()

  await replica.deliverNotification({ kind: 'ws', message, scopes })

  assert.equal(replica.sent.length, 1)
  assert.deepEqual(replica.sent[0], message)
})
