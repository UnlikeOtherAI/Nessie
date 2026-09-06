import assert from 'node:assert/strict'
import test from 'node:test'

import { buildRepositoryHookBody } from '../src/adapter.js'

/**
 * A repository hook is what lets a deployment with no GitHub App webhook
 * configured still hear about an issue the moment it changes. Unlike Linear,
 * GitHub takes the signing secret the caller offers — so the offer has to
 * actually reach the request, which is what these pin.
 */

test('the hook is signed with the secret this deployment offered', () => {
  const body = buildRepositoryHookBody({
    url: 'https://nessie.example/api/board-sources/webhooks/github/tok',
    secret: 'a-32-byte-hex-secret',
  })
  const config = body.config as Record<string, unknown>
  assert.equal(config.secret, 'a-32-byte-hex-secret')
  assert.equal(config.url, 'https://nessie.example/api/board-sources/webhooks/github/tok')
  // JSON, not form encoding: `verifyWebhook` hashes the raw body and GitHub's
  // form encoding would not be the bytes the adapter parses.
  assert.equal(config.content_type, 'json')
  assert.equal(config.insecure_ssl, '0')
})

test('the hook subscribes to issues and their labels, and nothing else', () => {
  const body = buildRepositoryHookBody({ url: 'https://x/y', secret: 's' })
  assert.deepEqual(body.events, ['issues', 'label'])
  assert.equal(body.active, true)
  assert.equal(body.name, 'web')
})
