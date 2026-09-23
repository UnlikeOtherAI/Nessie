import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PushDispatchJobPayloadSchema } from '../jobs.js'

const addressed = (overrides: Record<string, unknown> = {}) => ({
  authorName: 'DeepWater',
  channelId: randomUUID(),
  contentSnippet: 'Your DeepWater research has finished.',
  mentionUserIds: [],
  messageId: randomUUID(),
  organizationId: randomUUID(),
  recipientUserIds: [randomUUID()],
  threadId: randomUUID(),
  ...overrides,
})

test('a generic notification may carry its own wording in place of its content', () => {
  const parsed = PushDispatchJobPayloadSchema.parse(addressed({
    contentVisibility: 'generic',
    genericBody: '  Your DeepWater research has finished.  ',
  }))
  assert.equal(parsed.genericBody, 'Your DeepWater research has finished.')
})

test('only a generic notification replaces its content', () => {
  assert.equal(PushDispatchJobPayloadSchema.safeParse(addressed({ genericBody: 'News.' })).success, false)
  assert.equal(
    PushDispatchJobPayloadSchema.safeParse(addressed({ contentVisibility: 'full', genericBody: 'News.' })).success,
    false,
  )
  assert.equal(
    PushDispatchJobPayloadSchema.safeParse(addressed({ contentVisibility: 'generic', genericBody: ' ' })).success,
    false,
    'an empty wording would show nothing',
  )
})
