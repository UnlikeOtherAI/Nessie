import assert from 'node:assert/strict'
import test from 'node:test'

import { loadConfig } from '@nessie/config'

import {
  rateLimitFor,
  resolveGlobalRateLimitBucket,
} from '../src/routes/auth-rate-limit.js'

/**
 * Mailbox discovery fans one address out to DNS and several bounded HTTPS
 * requests, so it carries an IP budget even though it is authenticated. That
 * budget used to be a hard-coded constant in an in-process limiter; it is now
 * a named bucket with a config rule (2026-09-05 review, FO3-3), and this
 * pins both the pairing and the threshold it inherited.
 */
test('mailbox discovery resolves to its own bucket, capped at thirty per minute', () => {
  const bucket = resolveGlobalRateLimitBucket({
    isPublic: false,
    method: 'POST',
    routePath: '/api/mailbox-connections/discover',
  })
  assert.equal(bucket, 'mailboxDiscoverIp')

  const config = loadConfig({ argv: [], env: {} })
  const { bucket: storeKey, rule } = rateLimitFor(config, 'mailboxDiscoverIp')
  assert.equal(storeKey, 'api.mailbox_discover.ip')
  assert.deepEqual(rule, { max: 30, windowMs: 60_000 })
})

test('discovery is only limited on the write; reading connections is not', () => {
  assert.equal(
    resolveGlobalRateLimitBucket({
      isPublic: false,
      method: 'GET',
      routePath: '/api/mailbox-connections',
    }),
    null,
  )
})

test('local daemon pairing is tight before proof and flood-limited after proof', () => {
  assert.equal(
    resolveGlobalRateLimitBucket({
      isPublic: true,
      method: 'POST',
      routePath: '/api/local-inference/daemon/challenge',
    }),
    'executorDaemonIp',
  )
  for (const routePath of [
    '/api/local-inference/daemon/claim',
    '/api/local-inference/daemon/heartbeat',
    '/api/local-inference/daemon/attempts/poll',
    '/api/local-inference/daemon/attempts/frame',
    '/api/local-inference/daemon/attempts/result',
  ]) {
    assert.equal(
      resolveGlobalRateLimitBucket({ isPublic: true, method: 'POST', routePath }),
      'executorDaemonSessionIp',
    )
  }
})
