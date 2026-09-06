import assert from 'node:assert/strict'
import test from 'node:test'

import { createFastifyTrustProxyConfig } from '../src/lib/rate-limit.js'

test('Fastify proxy trust is disabled unless trusted proxy hops is explicit', () => {
  assert.equal(createFastifyTrustProxyConfig(0), false)
  assert.equal(createFastifyTrustProxyConfig(1), 1)
  assert.equal(createFastifyTrustProxyConfig(2), 2)
})
