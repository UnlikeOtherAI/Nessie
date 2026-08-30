import assert from 'node:assert/strict'
import test from 'node:test'

import type { SseFrame } from '../src/lib/sse.js'
import {
  createFrameFanout,
  type EventStreamConnection,
  type EventStreamListener,
} from '../src/facades/realtime/event-stream-fanout.js'
import { backlogWatermark } from '../src/facades/notifications/useMessageNotifications.js'

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
