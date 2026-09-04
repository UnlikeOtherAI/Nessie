import assert from 'node:assert/strict'
import test from 'node:test'

import { createGmailDraft, getGmailDraft } from '../src/gmail/drafts.js'
import { GmailReadLimitError } from '../src/gmail/read-budget.js'

const b64 = (value: string): string => Buffer.from(value).toString('base64url')

const response = (body: unknown) => ({
  json: async () => body,
  ok: true,
  status: 200,
  text: async () => JSON.stringify(body),
})

const draft = (payload: unknown) => ({
  id: 'draft-1',
  message: {
    id: 'message-1',
    payload,
    threadId: 'thread-1',
  },
})

test('Gmail draft reads reject decoded bodies beyond the explicit budget', async () => {
  await assert.rejects(
    getGmailDraft(async () => response(draft({
      headers: [{ name: 'To', value: 'person@example.test' }],
      mimeType: 'text/plain', body: { data: b64('x'.repeat(300 * 1024)) },
    })), 'token', 'draft-1'),
    GmailReadLimitError,
  )
})

test('Gmail draft reads reject recursive MIME trees before traversal grows unbounded', async () => {
  const root: { mimeType: string; parts?: unknown[] } = { mimeType: 'multipart/mixed' }
  let cursor = root
  for (let index = 0; index <= 20; index += 1) {
    const child = { mimeType: 'multipart/mixed' }
    cursor.parts = [child]
    cursor = child
  }
  await assert.rejects(
    getGmailDraft(async () => response(draft(root)), 'token', 'draft-1'),
    GmailReadLimitError,
  )
})

test('Gmail draft marks multipart alternatives as non-editable rather than flattening HTML', async () => {
  const result = await getGmailDraft(async () => response(draft({
    headers: [{ name: 'To', value: 'person@example.test' }],
    mimeType: 'multipart/alternative',
    parts: [
      { mimeType: 'text/plain', body: { data: b64('plain') } },
      { mimeType: 'text/html', body: { data: b64('<p>rich</p>') } },
    ],
  })), 'token', 'draft-1')
  assert.equal(result.editable, false)
  assert.equal(result.unsupportedReason, 'non_plain_content')
})

test('created Gmail replies bind the provider thread and RFC reply chain', async () => {
  let request: { body?: string } | undefined
  await createGmailDraft(async (_url, init) => {
    request = init
    return response({ id: 'draft-1', message: { id: 'message-1', threadId: 'thread-1' } })
  }, 'token', {
    to: ['person@example.test'], subject: 'Re: Status', body: 'Thanks.',
    inReplyTo: 'parent@example.test', references: ['parent@example.test'],
  }, 'thread-1')
  const message = JSON.parse(request?.body ?? '{}').message as { raw?: string; threadId?: string }
  const raw = Buffer.from(message.raw ?? '', 'base64url').toString('utf8')
  assert.equal(message.threadId, 'thread-1')
  assert.match(raw, /In-Reply-To: <parent@example\.test>/)
  assert.match(raw, /References: <parent@example\.test>/)
})
