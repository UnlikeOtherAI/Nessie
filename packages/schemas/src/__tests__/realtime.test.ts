import assert from 'node:assert/strict'
import { test } from 'node:test'

import { WsEventNameSchema, WsEventSchema } from '../realtime.js'

test('WsEventSchema accepts message reaction events', () => {
  assert.equal(WsEventNameSchema.parse('message.reaction'), 'message.reaction')

  const parsed = WsEventSchema.parse({
    type: 'event',
    event: 'message.reaction',
    data: {
      messageId: 'message-1',
      userId: '00000000-0000-4000-8000-000000000001',
      emoji: '\u{1F44D}',
    },
    ts: '2026-06-12T23:18:05.656Z',
  })

  assert.equal(parsed.event, 'message.reaction')
})
