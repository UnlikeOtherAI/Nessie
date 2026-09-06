import assert from 'node:assert/strict'
import test from 'node:test'

import type { RealtimeNotificationPayload } from '@nessie/runtime'
import { parseOrganizationId, parseUserId, type WsScope } from '@nessie/schemas'

import { createWsNotificationDelivery, type RealtimeFanOutLogger } from '../src/realtime/hub.js'

const organizationId = '00000000-0000-4000-8000-000000000001'
const threadId = '00000000-0000-4000-8000-000000000002'
const userId = '00000000-0000-4000-8000-000000000003'
const runId = '00000000-0000-4000-8000-000000000004'

type Warning = { details: Record<string, unknown>; message: string }

const recordingLogger = (): {
  logger: RealtimeFanOutLogger
  warnings: Warning[]
} => {
  const warnings: Warning[] = []
  return {
    logger: {
      warn: (details, message) => {
        warnings.push({ details, message })
      },
    },
    warnings,
  }
}

const collectingResponse = (written: string[]) => ({
  once: () => undefined,
  write: (chunk: string) => {
    written.push(chunk)
    return true
  },
})

const threadNotification = (sequence: number): RealtimeNotificationPayload => ({
  data: { content: `chunk-${sequence}`, runId },
  event: 'stream.delta',
  kind: 'sse',
  sequence,
  threadId,
  ts: new Date(0).toISOString(),
})

const scopes: WsScope[] = [
  {
    kind: 'user',
    organizationId: parseOrganizationId(organizationId),
    userId: parseUserId(userId),
  },
]

const wsMessage = {
  data: { callId: '00000000-0000-4000-8000-0000000000ca' },
  event: 'call.incoming',
  ts: new Date(0).toISOString(),
  type: 'event' as const,
}

const wsNotification = (eventId: string): RealtimeNotificationPayload => ({
  eventId,
  kind: 'ws',
  message: wsMessage,
  scopes,
})

// What an older publisher mid rolling deploy sends: no row id, because that
// build notified before it had one.
const idLessWsNotification = (): RealtimeNotificationPayload => ({
  kind: 'ws',
  message: wsMessage,
  scopes,
})

const userConnection = (written: string[]) => ({
  kind: 'user' as const,
  channelIds: new Set<string>(),
  hydrating: false,
  lastEventId: 0n,
  organizationId,
  pending: [],
  response: collectingResponse(written),
  scopes,
  userId,
})

/**
 * With the publisher holding a per-thread advisory lock across INSERT and
 * COMMIT, id order is commit order, so a sequence at or below the watermark
 * can only be the same event delivered twice — a LISTEN reconnect, or an old
 * publisher mid rolling deploy. It must be skipped without writing a second
 * copy and without touching the watermark, and it must say so at warn level
 * with both numbers, so a publisher that regressed to insert-then-notify is
 * visible in the logs instead of silently losing events.
 */
test('a duplicate thread notification at the watermark is skipped and warned about', async () => {
  const { logger, warnings } = recordingLogger()
  const { deliverNotification, threadSseConnections } = createWsNotificationDelivery({ logger })
  const written: string[] = []
  const connection = {
    kind: 'thread' as const,
    // No viewer, so the delivery-time entitlement recheck is a no-op and this
    // case is about the watermark alone.
    channelId: null,
    hydrating: false,
    lastSequence: 0,
    pending: [],
    response: collectingResponse(written),
    saturated: false,
    threadId,
    viewer: null,
  }
  threadSseConnections.add(connection)

  await deliverNotification(threadNotification(7))
  assert.equal(written.length, 1)
  assert.equal(connection.lastSequence, 7)
  assert.deepEqual(warnings, [])

  await deliverNotification(threadNotification(7))
  await deliverNotification(threadNotification(5))

  assert.equal(written.length, 1, 'a duplicate must not be written a second time')
  assert.equal(connection.lastSequence, 7, 'the watermark must not move for a skipped event')
  assert.equal(warnings.length, 2)
  for (const warning of warnings) {
    assert.match(warning.message, /watermark/)
    assert.equal(warning.details['lane'], 'thread')
    assert.equal(warning.details['lastSequence'], 7)
  }
  assert.equal(warnings[0]!.details['sequence'], 7)
  assert.equal(warnings[1]!.details['sequence'], 5)
})

/**
 * The same rule on the user lane, whose watermark is the `realtime_events` id
 * the publisher serialised per organization.
 */
test('a duplicate user notification at the watermark is skipped and warned about', async () => {
  const { logger, warnings } = recordingLogger()
  const { deliverNotification, userSseConnections } = createWsNotificationDelivery({ logger })
  const written: string[] = []
  const connection = userConnection(written)
  userSseConnections.add(connection)

  await deliverNotification(wsNotification('42'))
  assert.equal(written.length, 1)
  assert.equal(connection.lastEventId, 42n)
  assert.deepEqual(warnings, [])

  await deliverNotification(wsNotification('42'))
  await deliverNotification(wsNotification('11'))

  assert.equal(written.length, 1, 'a duplicate must not be written a second time')
  assert.equal(connection.lastEventId, 42n, 'the watermark must not move for a skipped event')
  assert.equal(warnings.length, 2)
  for (const warning of warnings) {
    assert.match(warning.message, /watermark/)
    assert.equal(warning.details['lane'], 'user')
    assert.equal(warning.details['lastEventId'], '42')
  }
  assert.equal(warnings[0]!.details['eventId'], '42')
  assert.equal(warnings[1]!.details['eventId'], '11')
})

/**
 * The other half of the same rule: what the watermark must *not* judge.
 *
 * A notification carrying no `eventId` comes from an older publisher mid
 * rolling deploy — that build issued the NOTIFY before it had a row id — and
 * the lane's own contract is that such an event "is fanned out live with no
 * replay bookkeeping". Gating the whole user fan-out on a row id instead meant
 * a client parked on a new replica received nothing at all from an old one, in
 * silence, for the entire deploy window. So it is delivered; it carries no
 * `id:`, because the row it would replay from is unknown here and any id would
 * strand the client's next reconnect; and it leaves `lastEventId` alone, so the
 * id-carrying events around it keep working.
 */
test('an id-less user notification is delivered live and never touches the watermark', async () => {
  const { logger, warnings } = recordingLogger()
  const { deliverNotification, userSseConnections } = createWsNotificationDelivery({ logger })
  const written: string[] = []
  const connection = userConnection(written)
  userSseConnections.add(connection)

  await deliverNotification(wsNotification('42'))
  assert.equal(written.length, 1)
  assert.equal(connection.lastEventId, 42n)

  await deliverNotification(idLessWsNotification())

  assert.equal(written.length, 2, 'an id-less notification must still reach the connection')
  assert.ok(
    !written[1]!.includes('id:'),
    `an id-less notification must not write an id: line, got ${JSON.stringify(written[1])}`,
  )
  assert.match(written[1]!, /event: call\.incoming/)
  assert.equal(
    connection.lastEventId,
    42n,
    'an id-less notification must not move the replay watermark',
  )
  assert.deepEqual(warnings, [], 'an id-less notification is not a watermark duplicate')

  // And the watermark still does its job around it: a replayable id at or below
  // it is the same event twice, and is skipped with a warning as before.
  await deliverNotification(wsNotification('42'))

  assert.equal(written.length, 2, 'an id-carrying duplicate must still be skipped')
  assert.equal(connection.lastEventId, 42n)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0]!.message, /watermark/)
  assert.equal(warnings[0]!.details['lane'], 'user')
})
