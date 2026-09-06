import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import test from 'node:test'

import { verifyHmacSignature } from '../src/secret-crypto.js'

const SECRET = 'deployment-signing-secret'
const BODY = Buffer.from('{"event":"push","id":42}', 'utf8')

const hexSignature = (payload: Buffer | string, secret = SECRET): string =>
  createHmac('sha256', secret).update(payload).digest('hex')

const base64UrlSignature = (payload: string, secret = SECRET): string =>
  createHmac('sha256', secret).update(payload).digest('base64url')

test('a signature the signer produced verifies, in both wire encodings', () => {
  assert.equal(
    verifyHmacSignature({
      encoding: 'hex',
      payload: BODY,
      secret: SECRET,
      signature: hexSignature(BODY),
    }),
    true,
  )
  assert.equal(
    verifyHmacSignature({
      encoding: 'base64url',
      payload: 'challenge-payload',
      secret: SECRET,
      signature: base64UrlSignature('challenge-payload'),
    }),
    true,
  )
})

test('a signature over different bytes, or under a different secret, is refused', () => {
  assert.equal(
    verifyHmacSignature({
      encoding: 'hex',
      payload: BODY,
      secret: SECRET,
      signature: hexSignature(Buffer.from('{"event":"push","id":43}', 'utf8')),
    }),
    false,
  )
  assert.equal(
    verifyHmacSignature({
      encoding: 'hex',
      payload: BODY,
      secret: SECRET,
      signature: hexSignature(BODY, 'a-different-secret'),
    }),
    false,
  )
})

test('a short, empty, truncated or absent signature is refused, never thrown on', () => {
  const full = hexSignature(BODY)
  for (const signature of [undefined, '', '   ', 'ab', full.slice(0, 32), `${full}00`]) {
    assert.equal(
      verifyHmacSignature({ encoding: 'hex', payload: BODY, secret: SECRET, signature }),
      false,
      `expected refusal for ${JSON.stringify(signature)}`,
    )
  }
  // Trailing junk after a valid hex digest used to slip through the callers
  // that hex-decoded before comparing: Buffer.from stops at the first invalid
  // character, so `<digest>zz` decoded to the digest's own bytes and matched.
  assert.equal(
    verifyHmacSignature({
      encoding: 'hex',
      payload: BODY,
      secret: SECRET,
      signature: `${full}zz`,
    }),
    false,
  )
  // An empty secret is a misconfiguration, not a wildcard.
  assert.equal(
    verifyHmacSignature({ encoding: 'hex', payload: BODY, secret: '', signature: full }),
    false,
  )
})

test('a GitHub-style prefix is stripped when the caller declares one, and only then', () => {
  const signature = `sha256=${hexSignature(BODY)}`
  assert.equal(
    verifyHmacSignature({
      encoding: 'hex',
      payload: BODY,
      prefix: 'sha256=',
      secret: SECRET,
      signature,
    }),
    true,
  )
  // Case of the prefix does not matter; the digest is compared either way.
  assert.equal(
    verifyHmacSignature({
      encoding: 'hex',
      payload: BODY,
      prefix: 'sha256=',
      secret: SECRET,
      signature: `SHA256=${hexSignature(BODY).toUpperCase()}`,
    }),
    true,
  )
  // Without `prefix`, the prefix is part of the value and must not match.
  assert.equal(
    verifyHmacSignature({ encoding: 'hex', payload: BODY, secret: SECRET, signature }),
    false,
  )
})

test('a domain-separated MAC never verifies as an undomained one, or under another domain', () => {
  const domained = createHmac('sha256', SECRET)
    .update('nessie.trigger.webhook.v1\0')
    .update(BODY)
    .digest('hex')

  assert.equal(
    verifyHmacSignature({
      domain: 'nessie.trigger.webhook.v1',
      encoding: 'hex',
      payload: BODY,
      secret: SECRET,
      signature: domained,
    }),
    true,
  )
  assert.equal(
    verifyHmacSignature({
      encoding: 'hex',
      payload: BODY,
      secret: SECRET,
      signature: domained,
    }),
    false,
  )
  assert.equal(
    verifyHmacSignature({
      domain: 'nessie.executor.challenge.v1',
      encoding: 'hex',
      payload: BODY,
      secret: SECRET,
      signature: domained,
    }),
    false,
  )
})
