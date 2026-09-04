import assert from 'node:assert/strict'
import test from 'node:test'

import {
  MAILBOX_TOOL_DEFINITIONS,
  MailboxSendToolInputSchema,
  parseStructuralApprovalToolArgs,
} from '../src/index.js'

const CONNECTION = '00000000-0000-4000-8000-000000000101'

test('mailbox_send requires an exact UUID mailbox identity in its schema and tool definition', () => {
  const send = MAILBOX_TOOL_DEFINITIONS.find((tool) => tool.id === 'mailbox_send')
  assert.ok(send?.parameters.required?.includes('connectionId'))
  assert.deepEqual(MailboxSendToolInputSchema.parse({
    connectionId: CONNECTION,
    subject: 'Status',
    text: 'All clear.',
    to: ['ops@example.test'],
  }).connectionId, CONNECTION)
  assert.throws(() => MailboxSendToolInputSchema.parse({
    subject: 'Status',
    text: 'All clear.',
    to: ['ops@example.test'],
  }))
  assert.throws(() => parseStructuralApprovalToolArgs('mailbox_send', {
    connectionId: 'not-a-uuid',
    subject: 'Status',
    text: 'All clear.',
    to: ['ops@example.test'],
  }))
})
