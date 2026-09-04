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

const draftResponse = (attachmentBody: Record<string, unknown>) => ({
  id: 'draft-1',
  message: {
    id: 'message-1',
    payload: {
      headers: [
        { name: 'To', value: 'jana@example.com' },
        { name: 'Subject', value: 'Quarterly update' },
      ],
      mimeType: 'multipart/mixed',
      parts: [
        {
          mimeType: 'text/plain',
          body: { data: Buffer.from('Here it is.', 'utf8').toString('base64url') },
        },
        {
          mimeType: 'application/pdf',
          filename: 'report.pdf',
          body: attachmentBody,
        },
      ],
    },
  },
})

const getDraft = (body: unknown) =>
  getGmailDraft(
    (async () => ({
      ok: true,
      status: 200,
      json: async () => body,
      text: async () => JSON.stringify(body),
    })) as never,
    'token',
    'draft-1',
  )

test('parses Gmail attachment identifiers and MIME type for server-side approval binding', async () => {
  const draft = await getDraft(draftResponse({ attachmentId: 'gmail-attachment-1', size: 1_024 }))

  assert.deepEqual(draft.attachments, [{
    attachmentId: 'gmail-attachment-1',
    filename: 'report.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 1_024,
  }])
})

test('hashes inline attachment bytes when Gmail omits an attachment identifier', async () => {
  const draft = await getDraft(draftResponse({
    data: Buffer.from('same-name replacement', 'utf8').toString('base64url'),
    size: 1_024,
  }))

  const attachment = draft.attachments[0]
  assert.equal(attachment?.attachmentId, undefined)
  assert.match(attachment?.inlineDataHash ?? '', /^[a-f0-9]{64}$/)
})

test('refuses an attachment Gmail cannot identify or hash', async () => {
  await assert.rejects(
    getDraft(draftResponse({ size: 1_024 })),
    /attachment without stable content identity/,
  )
})
