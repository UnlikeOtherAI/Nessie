import assert from 'node:assert/strict'
import test from 'node:test'

import { ListThreadActivityQuerySchema } from '../src/contracts/thread-activity.js'

test('accepts the explicit unread thread activity filter', () => {
  assert.deepEqual(ListThreadActivityQuerySchema.parse({ unread: 'true' }), { unread: 'true' })
  assert.deepEqual(ListThreadActivityQuerySchema.parse({ unread: '1' }), { unread: '1' })
  assert.equal(ListThreadActivityQuerySchema.safeParse({ unread: 'false' }).success, false)
})
