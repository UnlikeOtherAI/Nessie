import assert from 'node:assert/strict'
import test from 'node:test'

import { getGmailDraft } from '../src/gmail/drafts.js'
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
