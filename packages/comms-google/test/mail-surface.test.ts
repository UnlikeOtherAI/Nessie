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
  assert.ok(calls[0]?.includes('pageToken=old-token'))
  assert.ok(calls[0]?.includes('is%3Aunread'))
})

test('Gmail conversation sanitizes provider HTML before returning it', async () => {
  const conversation = await readGmailMailThread(async () => response({ messages: [{
    id: 'message-1', internalDate: '2000', payload: {
      headers: [{ name: 'Subject', value: 'Hi' }], mimeType: 'text/html',
      body: { data: b64('<script>bad()</script><img src="https://remote.test/a">safe') },
    }, threadId: 'thread-1',
  }] }), 'token', 'thread-1')
  assert.equal(conversation.messages[0]?.body.includes('<script'), false)
  assert.ok(conversation.messages[0]?.body.includes('data-blocked-src'))
  assert.equal(conversation.messages[0]?.blockedRemoteContent, true)
})
