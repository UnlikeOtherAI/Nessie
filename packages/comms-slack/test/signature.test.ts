import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { test } from 'node:test'

import {
  SlackSignatureError,
  verifySlackSignature,
} from '../src/signature.js'

const SECRET = 'shhh-signing-secret'
const NOW_MS = 1_721_550_000_000
const FRESH_TS = String(Math.floor(NOW_MS / 1000))

const sign = (secret: string, ts: string, body: string): string =>
  `v0=${crypto
    .createHmac('sha256', secret)
    .update(`v0:${ts}:${body}`, 'utf8')
    .digest('hex')}`

test('accepts a valid, fresh signature', () => {
  const body = '{"type":"url_verification","challenge":"abc"}'
  assert.doesNotThrow(() =>
    verifySlackSignature({
      signingSecret: SECRET,
      signature: sign(SECRET, FRESH_TS, body),
      timestamp: FRESH_TS,
      rawBody: body,
      nowMs: NOW_MS,
    }),
  )
})

test('rejects a tampered body (mismatch)', () => {
  const body = '{"type":"event_callback"}'
  const signature = sign(SECRET, FRESH_TS, body)
  assert.throws(
    () =>
      verifySlackSignature({
        signingSecret: SECRET,
        signature,
        timestamp: FRESH_TS,
        rawBody: `${body} tampered`,
        nowMs: NOW_MS,
      }),
    (error: unknown) =>
      error instanceof SlackSignatureError && error.reason === 'mismatch',
  )
})

test('rejects a wrong signing secret (mismatch)', () => {
  const body = '{"ok":true}'
  assert.throws(
    () =>
      verifySlackSignature({
        signingSecret: SECRET,
        signature: sign('other-secret', FRESH_TS, body),
        timestamp: FRESH_TS,
        rawBody: body,
        nowMs: NOW_MS,
      }),
    (error: unknown) =>
      error instanceof SlackSignatureError && error.reason === 'mismatch',
  )
})

test('rejects a stale timestamp beyond the 5-minute skew', () => {
  const body = '{"ok":true}'
  const staleTs = String(Math.floor(NOW_MS / 1000) - 6 * 60)
  assert.throws(
    () =>
      verifySlackSignature({
        signingSecret: SECRET,
        signature: sign(SECRET, staleTs, body),
        timestamp: staleTs,
        rawBody: body,
        nowMs: NOW_MS,
      }),
    (error: unknown) =>
      error instanceof SlackSignatureError && error.reason === 'stale',
  )
})

test('rejects a delivery missing signature headers', () => {
  assert.throws(
    () =>
      verifySlackSignature({
        signingSecret: SECRET,
        rawBody: '{}',
        nowMs: NOW_MS,
      }),
    (error: unknown) =>
      error instanceof SlackSignatureError && error.reason === 'missing',
  )
})
