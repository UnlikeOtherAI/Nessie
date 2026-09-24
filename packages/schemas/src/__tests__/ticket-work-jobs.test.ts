import assert from 'node:assert/strict'
import test from 'node:test'

import {
  TICKET_WORK_SESSION_TOPIC,
  TICKET_WORK_SWEEP_TOPIC,
  TRIGGER_DOCUMENT_DISPATCH_TOPIC,
  TRIGGER_TICKET_DISPATCH_TOPIC,
  TicketWorkSessionJobPayloadSchema,
  TicketWorkSweepJobPayloadSchema,
  TriggerDocumentDispatchJobPayloadSchema,
  TriggerTicketDispatchJobPayloadSchema,
} from '../jobs.js'
import { TICKET_WORK_PURPOSE } from '../ticket-work.js'

const ORG = '0b6f1c2a-3d4e-4f50-8a61-72839a4b5c6d'
const EVENT = '1c7f2d3b-4e5f-4061-9b72-8394ab5c6d7e'
const TRIGGER = '2d8f3e4c-5f60-4172-8c83-94a5bc6d7e8f'
const PAGE = '3e9f4f5d-6071-4283-9d94-a5b6cd7e8f90'
const WORK = '4fa05a6e-7182-4394-8ea5-b6c7de8f9a01'
const SESSION = '5ab16b7f-8293-44a5-9fb6-c7d8ef9a0b12'
const EXECUTOR = '6bc27c80-93a4-45b6-80c7-d8e9f0a1b2c3'

// Queue rows outlive a deploy, so a topic or purpose string is a wire value:
// renaming one strands every job and pending row already written under it.
test('the ticket-work topics and run purpose keep their wire names', () => {
  assert.equal(TRIGGER_TICKET_DISPATCH_TOPIC, 'trigger.ticket.dispatch')
  assert.equal(TRIGGER_DOCUMENT_DISPATCH_TOPIC, 'trigger.document.dispatch')
  assert.equal(TICKET_WORK_SESSION_TOPIC, 'ticket-work.session')
  assert.equal(TICKET_WORK_SWEEP_TOPIC, 'ticket-work.sweep')
  assert.equal(TICKET_WORK_PURPOSE, 'ticket.work')
})

test('trigger.ticket.dispatch carries the event and its organisation, by id', () => {
  const payload = { organizationId: ORG, taskEventId: EVENT }
  assert.deepEqual(TriggerTicketDispatchJobPayloadSchema.parse(payload), payload)
  assert.equal(TriggerTicketDispatchJobPayloadSchema.safeParse({ organizationId: ORG }).success, false)
  assert.equal(
    TriggerTicketDispatchJobPayloadSchema.safeParse({ organizationId: ORG, taskEventId: 'event-1' }).success,
    false,
  )
})

test('trigger.document.dispatch names the trigger and page, never a version', () => {
  const payload = { organizationId: ORG, pageId: PAGE, triggerId: TRIGGER }
  assert.deepEqual(TriggerDocumentDispatchJobPayloadSchema.parse(payload), payload)
  // The handler reads the latest version when the quiet window ends, so a
  // version the enqueuer happened to see is not part of the job.
  assert.deepEqual(
    TriggerDocumentDispatchJobPayloadSchema.parse({ ...payload, versionId: SESSION }),
    payload,
  )
  assert.equal(TriggerDocumentDispatchJobPayloadSchema.safeParse({ organizationId: ORG, pageId: PAGE }).success, false)
})

test('ticket-work.session carries the turn and only a status that wakes', () => {
  const payload = { organizationId: ORG, workId: WORK, sessionId: SESSION, turn: 3, status: 'waiting_for_input' }
  assert.deepEqual(TicketWorkSessionJobPayloadSchema.parse(payload), payload)
  for (const status of ['interrupted', 'failed', 'closed']) {
    assert.equal(TicketWorkSessionJobPayloadSchema.safeParse({ ...payload, status }).success, true, status)
  }
  const refused = [
    // A session still starting or working never wakes the ticket's agent.
    { ...payload, status: 'starting' },
    { ...payload, status: 'working' },
    { ...payload, status: 'ended' },
    { ...payload, turn: -1 },
    { ...payload, turn: 1.5 },
    { ...payload, turn: '3' },
    { ...payload, sessionId: 'session-1' },
    { organizationId: ORG, workId: WORK, sessionId: SESSION, status: 'failed' },
    { workId: WORK, sessionId: SESSION, turn: 3, status: 'failed' },
    // The reason is the report's categorical code, never free text.
    { ...payload, status: 'interrupted', reason: 'Hit the per-turn limit' },
  ]
  for (const candidate of refused) {
    assert.equal(TicketWorkSessionJobPayloadSchema.safeParse(candidate).success, false, JSON.stringify(candidate))
  }
  const interrupted = { ...payload, status: 'interrupted', reason: 'max_turn_minutes' }
  assert.deepEqual(TicketWorkSessionJobPayloadSchema.parse(interrupted), interrupted)
})

test('ticket-work.sweep takes only its idempotency bucket', () => {
  assert.deepEqual(TicketWorkSweepJobPayloadSchema.parse({}), {})
  assert.deepEqual(TicketWorkSweepJobPayloadSchema.parse({ bucket: '2026-09-23T14:05' }), { bucket: '2026-09-23T14:05' })
  assert.equal(TicketWorkSweepJobPayloadSchema.safeParse({ workId: WORK }).success, false)
  // The sweep is also the pool dispatcher, enqueued when a machine may have
  // come free. It reads the queue and the pools afresh, so the enqueuer can
  // never steer it to a record or a machine.
  assert.equal(TicketWorkSweepJobPayloadSchema.safeParse({ executorId: EXECUTOR }).success, false)
  // An enqueue by a transaction that may have freed a machine runs the machine steps only.
  assert.deepEqual(TicketWorkSweepJobPayloadSchema.parse({ bucket: '1', machinesOnly: true }), { bucket: '1', machinesOnly: true })
  assert.equal(TicketWorkSweepJobPayloadSchema.safeParse({ machinesOnly: false }).success, false)
})
