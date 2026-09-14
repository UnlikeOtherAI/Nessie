import assert from 'node:assert/strict'
import test from 'node:test'

import { getAlertLink, type UserAlertRecord } from '../src/facades/alerts/hooks.js'
import { triggerUrl } from '../src/facades/alerts/trigger-url.js'

const triggerId = '55555555-5555-4555-8555-555555555555'

test('trigger links use the shared durable selection query', () => {
  assert.equal(triggerUrl(triggerId), `/agents/triggers?trigger=${triggerId}`)
  assert.equal(triggerUrl('a/b'), '/agents/triggers?trigger=a%2Fb')
})

test('a trigger-health bell alert opens the exact trigger recovery controls', () => {
  const alert = {
    actorAgentId: null,
    actorDisplayName: null,
    actorUserId: null,
    boardSourceId: null,
    callId: null,
    channelId: null,
    channelLabel: null,
    createdAt: '2026-09-12T10:00:00.000Z',
    id: '44444444-4444-4444-8444-444444444444',
    kind: 'trigger_health',
    knowledgePageId: null,
    messageId: null,
    metadata: null,
    projectId: null,
    readAt: null,
    rootMessageId: null,
    taskId: null,
    threadId: null,
    triggerId,
  } satisfies UserAlertRecord

  assert.deepEqual(getAlertLink(alert), { to: triggerUrl(triggerId) })
})
