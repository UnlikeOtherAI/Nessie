import assert from 'node:assert/strict'
import test from 'node:test'
import { readChannelComposeReturnTo } from '../src/lib/channel-compose-navigation'

test('compose close returns only to a safe, non-compose internal route', () => {
  assert.equal(readChannelComposeReturnTo({ returnTo: '/channels/channel-1' }), '/channels/channel-1')
  assert.equal(readChannelComposeReturnTo({ returnTo: '/projects/project-1?tab=work' }), '/projects/project-1?tab=work')
  assert.equal(readChannelComposeReturnTo({ returnTo: '/channels/new?draft=1' }), '/channels')
  assert.equal(readChannelComposeReturnTo({ returnTo: '//outside.example' }), '/channels')
  assert.equal(readChannelComposeReturnTo(null), '/channels')
})
