import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  isSubscriptionProviderColumn,
  looksLikeSubscriptionProviderColumn,
  parseSubscriptionProviderColumn,
  subscriptionProviderKeyToColumn,
} from '../src/selection.js'
import { classifyOpenAiShapedFailure, fingerprintApiKey, maskApiKey } from '../src/adapters.js'

test('a subscription provider column round-trips through the namespace', () => {
  const column = subscriptionProviderKeyToColumn('kimi')
  assert.equal(column, 'subscription/kimi')
  assert.equal(parseSubscriptionProviderColumn(column), 'kimi')
  assert.equal(isSubscriptionProviderColumn(column), true)
})

test('an ordinary Ledger service id is never mistaken for a subscription', () => {
  for (const provider of ['openai', 'deepseek', 'kimi', 'jina', null, undefined, '']) {
    assert.equal(parseSubscriptionProviderColumn(provider), null, `${provider}`)
    assert.equal(looksLikeSubscriptionProviderColumn(provider), false, `${provider}`)
  }
})

test('an unknown adapter still LOOKS like a subscription, so it fails closed', () => {
  // This is the rolling-deploy case: an API replica writes an adapter this
  // worker does not have. It must not resolve to the organization's Ledger
  // route, which would move a person's spend onto the organization silently.
  const column = 'subscription/some-future-provider'
  assert.equal(parseSubscriptionProviderColumn(column), null)
  assert.equal(looksLikeSubscriptionProviderColumn(column), true)
})

test('403 is classified by provider reason, not treated as a dead credential', () => {
  // A relink button cannot fix a missing entitlement or a content refusal, so
  // only a real authentication failure may reach `auth`.
  assert.equal(classifyOpenAiShapedFailure({ status: 401 }), 'auth')
  assert.equal(
    classifyOpenAiShapedFailure({ status: 403, body: { error: { code: 'invalid_api_key' } } }),
    'auth',
  )
  assert.equal(
    classifyOpenAiShapedFailure({ status: 403, body: { error: { code: 'model_not_allowed' } } }),
    'entitlement',
  )
  assert.equal(
    classifyOpenAiShapedFailure({
      status: 403,
      body: { error: { code: 'content_policy_violation' } },
    }),
    'policy',
  )
  assert.equal(classifyOpenAiShapedFailure({ status: 429 }), 'quota')
  assert.equal(classifyOpenAiShapedFailure({ status: 503 }), 'transient')
})

test('an account fingerprint is stable and discloses nothing', () => {
  const key = 'sk-test-abcdef0123456789'
  assert.equal(fingerprintApiKey(key), fingerprintApiKey(key))
  assert.notEqual(fingerprintApiKey(key), fingerprintApiKey(`${key}x`))
  assert.equal(fingerprintApiKey(key).includes(key), false)
  assert.equal(maskApiKey(key).includes('abcdef'), false)
  assert.equal(maskApiKey('short').includes('short'), false)
})
