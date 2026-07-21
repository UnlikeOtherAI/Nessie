import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  buildHeaderIndex,
  collectAttachments,
  decodeBody,
  extractPlainTextBody,
  type GmailMessagePart,
} from '../src/mime.js'

const b64url = (text: string): string =>
  Buffer.from(text, 'utf8').toString('base64url')

// A realistic multipart/mixed message: a multipart/alternative body (text/plain
// + text/html) plus a PDF attachment carrying only an attachmentId, not bytes.
const multipartPayload: GmailMessagePart = {
  mimeType: 'multipart/mixed',
  headers: [
    { name: 'From', value: '"Sarah Doe" <sarah@example.com>' },
    { name: 'To', value: 'me@example.com, Bob <bob@example.com>' },
    { name: 'Subject', value: 'Deployment doc' },
  ],
  parts: [
    {
      mimeType: 'multipart/alternative',
      parts: [
        { mimeType: 'text/plain', body: { size: 12, data: b64url('hello world') } },
        { mimeType: 'text/html', body: { size: 20, data: b64url('<p>hello world</p>') } },
      ],
    },
    {
      mimeType: 'application/pdf',
      filename: 'guide.pdf',
      body: { size: 8192, attachmentId: 'ATTACH_123' },
    },
  ],
}

test('header index is case-insensitive', () => {
  const index = buildHeaderIndex(multipartPayload.headers)
  assert.equal(index.get('from'), '"Sarah Doe" <sarah@example.com>')
  assert.equal(index.get('subject'), 'Deployment doc')
  assert.equal(index.get('missing'), undefined)
})

test('decodeBody decodes base64url to UTF-8', () => {
  assert.equal(decodeBody(b64url('café ☕')), 'café ☕')
  assert.equal(decodeBody(undefined), undefined)
})

test('extractPlainTextBody prefers the nested text/plain part', () => {
  assert.equal(extractPlainTextBody(multipartPayload), 'hello world')
})

test('collectAttachments records metadata only, never bytes', () => {
  const attachments = collectAttachments(multipartPayload)
  assert.deepEqual(attachments, [
    {
      externalId: 'ATTACH_123',
      name: 'guide.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 8192,
    },
  ])
})

test('a text/plain part used as an attachment is not treated as the body', () => {
  const payload: GmailMessagePart = {
    mimeType: 'multipart/mixed',
    parts: [
      { mimeType: 'text/plain', filename: 'notes.txt', body: { attachmentId: 'A1', size: 3 } },
      { mimeType: 'text/plain', body: { data: b64url('real body'), size: 9 } },
    ],
  }
  assert.equal(extractPlainTextBody(payload), 'real body')
})
