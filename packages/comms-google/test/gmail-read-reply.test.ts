import assert from 'node:assert/strict'
import test from 'node:test'

import { getGmailMessage, getGmailThread, searchGmailThreads } from '../src/gmail/read.js'

const message = {
  id: 'gmail-message-1', threadId: 'gmail-thread-1', internalDate: '0',
  payload: { headers: [
    { name: 'From', value: 'sender@example.com' }, { name: 'To', value: 'recipient@example.com' },
    { name: 'Subject', value: 'Status' }, { name: 'Message-ID', value: '<parent@example.com>' },
  ], mimeType: 'text/plain', body: { data: Buffer.from('Hello').toString('base64url') } },
}

const response = (body: unknown) => ({
  ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body),
})

test('Gmail read results expose RFC Message-ID separately from provider ids', async () => {
  const fetch = async (url: string) => {
    if (url.includes('/messages?')) return response({ messages: [{ id: message.id }] })
    if (url.includes('/threads/')) return response({ messages: [message] })
    return response(message)
  }
  const [search] = await searchGmailThreads(fetch, 'token', { maxResults: 1 })
  const detail = await getGmailMessage(fetch, 'token', message.id)
  const [threadMessage] = await getGmailThread(fetch, 'token', message.threadId)

  assert.equal(search?.messageId, 'gmail-message-1')
  assert.equal(search?.threadId, 'gmail-thread-1')
  assert.equal(search?.rfcMessageId, '<parent@example.com>')
  assert.equal(detail.rfcMessageId, '<parent@example.com>')
  assert.equal(threadMessage?.rfcMessageId, '<parent@example.com>')
})
