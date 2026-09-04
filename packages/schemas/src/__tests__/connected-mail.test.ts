import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ConnectedMailComposeInputSchema,
  ConnectedMailThreadsQuerySchema,
} from '../connected-mail.js'

test('connected mail compose input refuses a client-supplied sender', () => {
  const result = ConnectedMailComposeInputSchema.safeParse({
    body: 'Hello',
    from: 'spoofed@example.test',
    subject: 'Hi',
    to: ['recipient@example.test'],
  })
  assert.equal(result.success, false)
})

test('connected mail list paging is bounded and query text is optional', () => {
  assert.deepEqual(ConnectedMailThreadsQuerySchema.parse({}), { pageSize: 25 })
  assert.equal(ConnectedMailThreadsQuerySchema.safeParse({ pageSize: 101 }).success, false)
  assert.equal(ConnectedMailThreadsQuerySchema.safeParse({ query: '   ' }).success, false)
})
