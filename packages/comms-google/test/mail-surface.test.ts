import assert from 'node:assert/strict'
import test from 'node:test'

import { listGmailMailThreads, readGmailMailThread } from '../src/gmail/mail-surface.js'

const b64 = (value: string): string => Buffer.from(value).toString('base64url')

const response = (body: unknown) => ({
  json: async () => body,
  ok: true,
  status: 200,
  text: async () => JSON.stringify(body),
})

test('Gmail mail paging preserves the provider cursor and estimate', async () => {
  const calls: string[] = []
  const fetch = async (url: string) => {
    calls.push(url)
    if (url.includes('/threads?')) return response({
      nextPageToken: 'google-next-token', resultSizeEstimate: 4242, threads: [{ id: 'thread-1' }],
    })
    return response({ messages: [{
      id: 'message-1', internalDate: '1000', labelIds: ['UNREAD'], payload: {
        headers: [{ name: 'From', value: 'sender@example.test' }, { name: 'Subject', value: 'Hello' }],
        mimeType: 'text/html', body: { data: b64('<img src="https://tracker.test/pixel">hello') },
      }, threadId: 'thread-1',
    }] })
  }
  const page = await listGmailMailThreads(fetch, 'token', {
    cursor: 'old-token', pageSize: 25, query: 'from:sender@example.test', unreadOnly: true,
  })
  assert.equal(page.nextCursor, 'google-next-token')
  assert.equal(page.estimate, 4242)
  assert.equal(page.items[0]?.unread, true)
  assert.equal(page.items[0]?.messageCount, 1)
  assert.equal(page.items[0]?.subject, 'Hello')
  assert.ok(calls[0]?.includes('pageToken=old-token'))
  assert.ok(calls[0]?.includes('is%3Aunread'))
  assert.ok(calls[1]?.includes('format=metadata'))
  assert.equal(calls.some((url) => url.includes('format=full')), false)
})

test('Gmail conversation sanitizes provider HTML before returning it', async () => {
  const conversation = await readGmailMailThread(async () => response({ messages: [{
    id: 'message-1', internalDate: '2000', payload: {
      headers: [
        { name: 'Subject', value: 'Hi' },
        { name: 'Message-ID', value: ' <Reply@Example.Test> ' },
        { name: 'In-Reply-To', value: ' <Parent@Example.Test> ' },
      ], mimeType: 'text/html',
      body: { data: b64('<script>bad()</script><img src="https://remote.test/a">safe') },
    }, threadId: 'thread-1',
  }] }), 'token', 'thread-1')
  assert.equal(conversation.messages[0]?.body.includes('<script'), false)
  assert.ok(conversation.messages[0]?.body.includes('data-blocked-src'))
  assert.equal(conversation.messages[0]?.blockedRemoteContent, true)
  assert.equal(conversation.messages[0]?.messageId, 'reply@example.test')
  assert.equal(conversation.messages[0]?.inReplyTo, 'parent@example.test')
})

test('Gmail conversation clamps provider data to the connected-mail contract', async () => {
  const conversation = await readGmailMailThread(async () => response({ messages: [{
    id: 'message-1', internalDate: '2000', payload: {
      headers: [
        { name: 'From', value: 'f'.repeat(1_001) },
        { name: 'Subject', value: 's'.repeat(1_001) },
        { name: 'To', value: Array.from({ length: 101 }, (_, i) => `person${i}@example.test`).join(',') },
      ],
      mimeType: 'text/plain', body: { data: b64('x'.repeat(100_001)) },
    }, threadId: 'thread-1',
  }] }), 'token', 'thread-1')
  const message = conversation.messages[0]
  assert.equal(message?.body.length, 100_000)
  assert.equal(message?.from?.length, 1_000)
  assert.equal(message?.subject.length, 1_000)
  assert.equal(message?.to.length, 100)
})

test('Gmail preserves quoted display-name recipients and inline filename attachments', async () => {
  const conversation = await readGmailMailThread(async () => response({ messages: [{
    id: 'message-1', internalDate: '2000', payload: {
      filename: 'logo.png', mimeType: 'image/png', body: { data: b64('inline') },
      headers: [{ name: 'To', value: '"Nessie, Team" <team@example.test>, person@example.test' }],
    }, threadId: 'thread-1',
  }] }), 'token', 'thread-1')
  assert.deepEqual(conversation.messages[0]?.to, [
    '"Nessie, Team" <team@example.test>', 'person@example.test',
  ])
  assert.equal(conversation.messages[0]?.attachments[0]?.filename, 'logo.png')
})
