import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ExecutorConversationLeaseRecordSchema,
  ExecutorLeaseListQuerySchema,
  ExecutorMachineLeaseRecordSchema,
} from '../executor-leases.js'
import { WsEventNameSchema, WsEventSchema } from '../realtime-ws.js'

const leaseId = '99999999-9999-4999-8999-999999999991'
const threadId = '66666666-6666-4666-8666-666666666666'

test('executor.lease.changed rides the unchanged envelope, with ids only', () => {
  assert.equal(WsEventNameSchema.safeParse('executor.lease.changed').success, true)
  const parsed = WsEventSchema.parse({
    type: 'event', event: 'executor.lease.changed', ts: '2026-09-23T20:00:00.000Z', data: { leaseId, threadId },
  })
  assert.deepEqual(parsed.data, { leaseId, threadId })
  assert.equal(WsEventSchema.safeParse({
    type: 'event', event: 'executor.lease.changed', ts: '2026-09-23T20:00:00.000Z', data: { leaseId: 'x', threadId },
  }).success, false)
})

test('the holder’s record names the machine; the machine’s record may name neither agent nor room', () => {
  const own = {
    id: leaseId, agentId: leaseId, executorLabel: 'Minis', threadId, rootMessageId: leaseId,
    launchedAt: '2026-09-23T19:00:00.000Z', expiresAt: '2026-09-23T21:00:00.000Z',
  }
  assert.equal(ExecutorConversationLeaseRecordSchema.safeParse(own).success, true)
  assert.equal(
    ExecutorConversationLeaseRecordSchema.safeParse({ ...own, holderUserId: leaseId }).success,
    false,
    'strict: nothing else rides along',
  )
  assert.equal(ExecutorMachineLeaseRecordSchema.safeParse({
    id: leaseId, agent: { id: leaseId, name: null }, holderUserId: leaseId,
    conversation: { channelId: leaseId, threadId, label: null },
    launchedAt: own.launchedAt, lastUsedAt: own.launchedAt, expiresAt: own.expiresAt,
  }).success, true)
  assert.equal(ExecutorLeaseListQuerySchema.safeParse({}).success, false)
  assert.equal(ExecutorLeaseListQuerySchema.safeParse({ threadId: 'x' }).success, false)
})
