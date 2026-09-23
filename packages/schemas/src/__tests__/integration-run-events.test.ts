import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { WsEventNameSchema, WsEventSchema } from '../realtime-ws.js'

/**
 * `integration.run.updated` (Water plan nessie.md §7.7) is content-free: the
 * product and the run id ride the wire, and nothing else can — a research's
 * topic, brief or result is disclosed only by the viewer-scoped read.
 */

const event = (data: unknown) => ({ type: 'event', event: 'integration.run.updated', data, ts: new Date().toISOString() })

test('integration.run.updated carries the product and run id only', () => {
  assert.equal(WsEventNameSchema.safeParse('integration.run.updated').success, true)
  const runId = randomUUID()
  const parsed = WsEventSchema.parse(event({ productSlug: 'deep-water', runId }))
  assert.deepEqual(parsed.data, { productSlug: 'deep-water', runId })

  assert.equal(WsEventSchema.safeParse(event({ productSlug: 'deep-water', runId, topic: 'Heat pumps' })).success, false)
  assert.equal(WsEventSchema.safeParse(event({ productSlug: 'deep-water', runId: 'rs_abc' })).success, false)
  assert.equal(WsEventSchema.safeParse(event({ productSlug: 'Deep Water', runId })).success, false)
})
