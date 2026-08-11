import assert from 'node:assert/strict'
import test from 'node:test'

import { resolvePushSurface } from '../src/lib/push-surface.js'

test('maps only exact push-targetable destinations to a structured surface', () => {
  assert.deepEqual(
    resolvePushSurface('/channels/00000000-0000-4000-8000-000000000001'),
    { kind: 'channel', channelId: '00000000-0000-4000-8000-000000000001' },
  )
  assert.deepEqual(resolvePushSurface('/ops/usage'), { kind: 'ops_usage' })
  assert.deepEqual(
    resolvePushSurface(
      '/channels/00000000-0000-4000-8000-000000000001/threads/00000000-0000-4000-8000-000000000002/replies/00000000-0000-4000-8000-000000000003',
    ),
    { kind: 'channel', channelId: '00000000-0000-4000-8000-000000000001' },
  )
  assert.equal(resolvePushSurface('/channels'), null)
  assert.equal(resolvePushSurface('/settings/notifications'), null)
})
