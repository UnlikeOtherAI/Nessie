import assert from 'node:assert/strict'
import test from 'node:test'

import { getGmailDraft } from '@nessie/comms-google'

import { gmailFetch } from '../src/gmail-drafts.js'
import { ENCRYPTION_SECRET } from './gmail-draft-test-support.js'

test('the Gmail fetch adapter preserves streaming bytes and response headers', async () => {
  const upstream = new Response('{"ok":true}', { headers: { 'content-length': '11' } })
  const response = await gmailFetch({
    encryptionSecret: ENCRYPTION_SECRET,
    fetchImpl: (async () => upstream) as never,
  })('https://gmail.example.test/drafts')
  assert.ok(response.body, 'bounded reads require the original response stream')
  assert.equal(response.headers?.get('content-length'), '11')
})

test('the Gmail fetch adapter applies a provider content-length cap', async () => {
  await assert.rejects(
    getGmailDraft(gmailFetch({
      encryptionSecret: ENCRYPTION_SECRET,
      fetchImpl: (async () => new Response('{}', {
        headers: { 'content-length': String(512 * 1024 + 1) },
      })) as never,
    }), 'token', 'draft-1'),
    /response exceeds 524288 bytes/,
  )
})

test('the Gmail fetch adapter cancels an overflowing provider stream', async () => {
  let cancelled = false
  const stream = new ReadableStream<Uint8Array>({
    cancel: () => { cancelled = true },
    pull: (controller) => controller.enqueue(new Uint8Array(512 * 1024 + 1)),
  })
  await assert.rejects(
    getGmailDraft(gmailFetch({
      encryptionSecret: ENCRYPTION_SECRET,
      fetchImpl: (async () => new Response(stream)) as never,
    }), 'token', 'draft-1'),
    /response exceeds 524288 bytes/,
  )
  assert.equal(cancelled, true)
})
