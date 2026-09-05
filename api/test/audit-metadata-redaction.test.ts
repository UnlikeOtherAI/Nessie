import assert from 'node:assert/strict'
import test from 'node:test'

import { redactMetadata } from '../src/services/audit.js'

/**
 * The audit trail is the redaction rule's first-named sink, and its redactor
 * was the instance's weakest: a hand-listed set of exact key names, with array
 * values passed through unexamined. `clientSecret`, `webhookSecret` and
 * `apiToken` all cleared it. It now asks `@nessie/mcp-manage`'s `isSecretKey` —
 * the same predicate that guards a catalog response — and recurses into arrays.
 */

test('pattern-named secrets are redacted, not just the exact legacy names', () => {
  const redacted = redactMetadata({
    apiToken: 'sk-live-1',
    clientSecret: 'shhh',
    clientId: 'visible-client',
    webhookSecret: 'shhh',
    tokenUrl: 'https://example.test/token',
    privateKey: 'BEGIN RSA',
  })

  assert.deepEqual(redacted, {
    apiToken: '[REDACTED]',
    clientSecret: '[REDACTED]',
    // `*Id` and `*Url` survive: they are what a reader needs to understand the
    // record, and the shared predicate excludes those suffixes deliberately.
    clientId: 'visible-client',
    webhookSecret: '[REDACTED]',
    tokenUrl: 'https://example.test/token',
    privateKey: '[REDACTED]',
  })
})

test('arrays are recursed into rather than skipped', () => {
  // The old redactor's `!Array.isArray(value)` guard let every element of this
  // list through untouched.
  const redacted = redactMetadata({
    overrides: [{ token: 'a', principalId: 'p1' }, { token: 'b', principalId: 'p2' }],
  })

  assert.deepEqual(redacted, {
    overrides: [
      { token: '[REDACTED]', principalId: 'p1' },
      { token: '[REDACTED]', principalId: 'p2' },
    ],
  })
})

test('a secret handed in as an object is replaced whole, not walked into', () => {
  const redacted = redactMetadata({ secret: { value: 'plaintext' }, scope: 'team' })

  assert.deepEqual(redacted, { secret: '[REDACTED]', scope: 'team' })
})

test('the legacy names and the domain-verification challenge still redact', () => {
  const redacted = redactMetadata({
    challenge: 'nessie-verify=abc',
    nested: { passwordHash: 'x', bootstrapToken: 'y', displayName: 'Ada' },
  })

  assert.deepEqual(redacted, {
    challenge: '[REDACTED]',
    nested: { passwordHash: '[REDACTED]', bootstrapToken: '[REDACTED]', displayName: 'Ada' },
  })
})
