import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import type { SseFrame } from '../src/lib/sse.js'
import {
  createFrameFanout,
  type EventStreamConnection,
  type EventStreamListener,
} from '../src/facades/realtime/event-stream-fanout.js'
import {
  parseIncomingCallEvent,
  resolveRingIntent,
} from '../src/facades/calls/incoming-call-stream.js'
import { backlogWatermark } from '../src/facades/notifications/useMessageNotifications.js'

const SRC = fileURLToPath(new URL('../src', import.meta.url))

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry)
    return statSync(path).isDirectory() ? walk(path) : [path]
  })

const frame = (event: string): SseFrame => ({ data: '{}', event, id: '1' })

const connection = (overrides: Partial<EventStreamConnection> = {}): EventStreamConnection => ({
  openedAt: 1_000,
  resumed: false,
  ...overrides,
})

const recorder = (into: string[], name: string): EventStreamListener => (received) => {
  into.push(`${name}:${received.event}`)
}

test('every subscriber sees every frame, because the route filters nothing per connection', async () => {
  const seen: string[] = []
  const fanout = createFrameFanout()
  fanout.subscribe(recorder(seen, 'alerts'))
  fanout.subscribe(recorder(seen, 'notifications'))

  await fanout.deliver(frame('alert.created'), connection())
  await fanout.deliver(frame('message.new'), connection())

  assert.deepEqual(seen, [
    'alerts:alert.created',
    'notifications:alert.created',
    'alerts:message.new',
    'notifications:message.new',
  ])
})

test('a throwing subscriber costs neither its sibling nor the connection', async () => {
  const seen: string[] = []
  const fanout = createFrameFanout()
  fanout.subscribe(() => {
    throw new Error('bad payload')
  })
  fanout.subscribe(recorder(seen, 'notifications'))

  await fanout.deliver(frame('message.new'), connection())

  assert.deepEqual(seen, ['notifications:message.new'])
})

test('a rejected subscriber is contained the same way', async () => {
  const seen: string[] = []
  const fanout = createFrameFanout()
  fanout.subscribe(async () => {
    await Promise.reject(new Error('notification failed'))
  })
  fanout.subscribe(recorder(seen, 'alerts'))

  await fanout.deliver(frame('alert.read'), connection())

  assert.deepEqual(seen, ['alerts:alert.read'])
})

// One socket now feeds both subscribers, so the notifier's REST round-trips
// must not queue in front of the alert bell — a delay neither could impose on
// the other while they each had a connection. The batch is still awaited as a
// whole, so the drain keeps the back-pressure it had before.
test('a slow subscriber does not hold a fast one behind it, and the batch still gates the drain', async () => {
  const order: string[] = []
  const fanout = createFrameFanout()
  fanout.subscribe(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5))
    order.push('slow')
  })
  fanout.subscribe(() => {
    order.push('fast')
  })

  await fanout.deliver(frame('message.new'), connection())

  assert.deepEqual(order, ['fast', 'slow'])
})

test('the size the transport starts and stops on counts live subscribers only', () => {
  const fanout = createFrameFanout()
  assert.equal(fanout.size(), 0)

  const leaveAlerts = fanout.subscribe(() => undefined)
  const leaveNotifications = fanout.subscribe(() => undefined)
  assert.equal(fanout.size(), 2)

  leaveAlerts()
  // The bell unmounting must not close the connection the notifier is reading.
  assert.equal(fanout.size(), 1)

  leaveNotifications()
  assert.equal(fanout.size(), 0)
})

test('an unsubscribed listener stops receiving frames', async () => {
  const seen: string[] = []
  const fanout = createFrameFanout()
  const leave = fanout.subscribe(recorder(seen, 'alerts'))

  await fanout.deliver(frame('alert.created'), connection())
  leave()
  await fanout.deliver(frame('alert.read'), connection())

  assert.deepEqual(seen, ['alerts:alert.created'])
})

test('a cold connection suppresses the replayed backlog, a resumed one does not', () => {
  // Cold: the hub replays its buffer to warm the feed, and toasting that would
  // announce messages the user has already read.
  assert.equal(backlogWatermark(connection({ openedAt: 1_700, resumed: false })), 1_700)
  // Resumed: the replay is exactly what this session missed, so it is news.
  assert.equal(backlogWatermark(connection({ openedAt: 1_700, resumed: true })), 0)
})

/**
 * The incoming-call reader is the fifth subscriber, not a fifth connection.
 *
 * It used to open its own `/api/events/stream` with its own reconnect loop,
 * which is exactly the shape that made the route — which marks presence per
 * connection — flap a reading user offline.
 */
const callFrame = (overrides: Record<string, unknown> = {}): SseFrame => ({
  data: JSON.stringify({
    data: {
      callId: '33333333-3333-4333-8333-333333333333',
      caller: {
        avatarUrl: null,
        displayName: 'Ada',
        id: '44444444-4444-4444-8444-444444444444',
      },
      channelId: '55555555-5555-4555-8555-555555555555',
      channelName: 'Design',
      expiresAt: '2026-09-05T12:00:30.000Z',
      meetingUri: 'https://meet.example.com/room',
      revision: 1,
      ...overrides,
    },
    event: 'call.incoming',
    ts: '2026-09-05T12:00:00.000Z',
    type: 'event',
  }),
  event: 'call.incoming',
  id: '17',
})

const ringingNow = Date.parse('2026-09-05T12:00:00.000Z')

test('a call frame on the shared stream is a ring the dialog can show', () => {
  const event = parseIncomingCallEvent(callFrame())
  assert.ok(event)
  assert.equal(event.event, 'call.incoming')
  assert.equal(event.data.callId, '33333333-3333-4333-8333-333333333333')
  assert.equal(
    resolveRingIntent({ call: event.data, connection: connection(), now: ringingNow }),
    'ring',
  )
})

test('a ring replayed onto a resumed connection is verified before it makes sound', () => {
  const event = parseIncomingCallEvent(callFrame())
  assert.ok(event?.event === 'call.incoming')
  assert.equal(
    resolveRingIntent({
      call: event.data,
      connection: connection({ resumed: true }),
      now: ringingNow,
    }),
    'verify',
  )
})

test('an expired ring on a cold connection stays silent', () => {
  const event = parseIncomingCallEvent(callFrame({ expiresAt: '2026-09-05T11:59:00.000Z' }))
  assert.ok(event?.event === 'call.incoming')
  assert.equal(
    resolveRingIntent({ call: event.data, connection: connection(), now: ringingNow }),
    'none',
  )
})

test('a frame that is not a call event is not one', () => {
  assert.equal(parseIncomingCallEvent(frame('message.new')), null)
  assert.equal(parseIncomingCallEvent({ ...callFrame(), data: '{' }), null)
  // No id means no monotonic position, and the reducer cannot order it.
  assert.equal(parseIncomingCallEvent({ ...callFrame(), id: undefined }), null)
})

test('exactly one file opens a connection to /api/events/stream', () => {
  const openers = walk(SRC)
    .filter((file) => file.endsWith('.ts') || file.endsWith('.tsx'))
    .filter((file) => /fetch\([^\n]*\/api\/events\/stream/.test(readFileSync(file, 'utf8')))
    .map((file) => `src/${relative(SRC, file).replaceAll('\\', '/')}`)

  assert.deepEqual(openers, ['src/facades/realtime/event-stream.ts'])
})

test('exactly one file opens the activity WebSocket', () => {
  const openers = walk(SRC)
    .filter((file) => file.endsWith('.ts') || file.endsWith('.tsx'))
    .filter((file) => /new WebSocket\(resolveWebSocketUrl/.test(readFileSync(file, 'utf8')))
    .map((file) => `src/${relative(SRC, file).replaceAll('\\', '/')}`)

  assert.deepEqual(openers, ['src/facades/agents/activity-socket.ts'])
})
