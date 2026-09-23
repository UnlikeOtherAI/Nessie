import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_TICKET_FOLLOW_KINDS,
  TICKET_EVENT_FOLLOW_KINDS,
  TICKET_FOLLOW_WAKE_REASONS,
  TICKET_TRIGGER_EVENT_TYPES,
  TicketChangedStoredConfigSchema,
  TicketFollowKindSchema,
  TicketTriggerDeliveryPayloadSchema,
} from '../ticket-triggers.js'
import { TicketWorkWakeReasonSchema } from '../ticket-work.js'

const BOARD = '0b6f1c2a-3d4e-4f50-8a61-72839a4b5c6d'
const COLUMN = '1c7f2d3b-4e5f-4061-9b72-8394ab5c6d7e'
const EVENT = '2d8f3e4c-5f60-4172-8c83-94a5bc6d7e8f'
const TASK = '3e9f4f5d-6071-4283-9d94-a5b6cd7e8f90'

test('a stored config with only its board follows the default kinds and ends on todo and done', () => {
  const parsed = TicketChangedStoredConfigSchema.parse({ boardId: BOARD })
  assert.equal(parsed.pickup, null)
  assert.deepEqual(parsed.follow, { kinds: [...DEFAULT_TICKET_FOLLOW_KINDS], includeSourceEvents: false })
  assert.deepEqual(parsed.endOn, [{ category: 'todo' }, { category: 'done' }])
})

test('a pickup assigns on pickup unless told not to, and names at least one column', () => {
  const parsed = TicketChangedStoredConfigSchema.parse({ boardId: BOARD, pickup: { columnIds: [COLUMN] } })
  assert.deepEqual(parsed.pickup, { columnIds: [COLUMN], assignOnPickup: true })
  assert.equal(TicketChangedStoredConfigSchema.safeParse({ boardId: BOARD, pickup: { columnIds: [] } }).success, false)
  // Stored by id only: a name or category is resolved before it is written.
  assert.equal(
    TicketChangedStoredConfigSchema.safeParse({ boardId: BOARD, pickup: { columnIds: ['In progress'] } }).success,
    false,
  )
})

test('the fields dispatch does not read survive a parse', () => {
  const parsed = TicketChangedStoredConfigSchema.parse({ boardId: BOARD, instructions: { general: 'Be brief.' } })
  assert.deepEqual((parsed as Record<string, unknown>).instructions, { general: 'Be brief.' })
})

test('every follow kind wakes with a reason in the wake vocabulary', () => {
  for (const kind of TicketFollowKindSchema.options) {
    assert.equal(TicketWorkWakeReasonSchema.safeParse(TICKET_FOLLOW_WAKE_REASONS[kind]).success, true, kind)
  }
  for (const eventType of TICKET_TRIGGER_EVENT_TYPES) {
    const kind = TICKET_EVENT_FOLLOW_KINDS[eventType]
    if (kind !== null) assert.equal(TicketFollowKindSchema.safeParse(kind).success, true, eventType)
  }
  // A create is a pickup or nothing, never a follow.
  assert.equal(TICKET_EVENT_FOLLOW_KINDS.created, null)
})

test('a delivery says why exactly when it was skipped', () => {
  const base = { taskEventId: EVENT, taskId: TASK, eventType: 'column_entered', originKind: 'agent' }
  assert.equal(
    TicketTriggerDeliveryPayloadSchema.safeParse({ ...base, outcome: 'skipped', skipReason: 'agent_origin' }).success,
    true,
  )
  assert.equal(TicketTriggerDeliveryPayloadSchema.safeParse({ ...base, outcome: 'skipped' }).success, false)
  assert.equal(
    TicketTriggerDeliveryPayloadSchema.safeParse({ ...base, outcome: 'pickup', skipReason: 'agent_origin' }).success,
    false,
  )
  assert.equal(
    TicketTriggerDeliveryPayloadSchema.safeParse({ ...base, outcome: 'skipped', skipReason: 'because' }).success,
    false,
  )
})

test('a thread message names its message, every other event its TaskEvent, never both', () => {
  const MESSAGE = '4fa05a6e-7182-4394-8ea5-b6c7de8f9012'
  const woken = { taskId: TASK, originKind: 'session', outcome: 'follow', wakeReason: 'thread_message' }
  assert.equal(
    TicketTriggerDeliveryPayloadSchema.safeParse({ ...woken, eventType: 'thread_message', messageId: MESSAGE }).success,
    true,
  )
  assert.equal(TicketTriggerDeliveryPayloadSchema.safeParse({ ...woken, eventType: 'thread_message' }).success, false)
  assert.equal(
    TicketTriggerDeliveryPayloadSchema.safeParse({
      ...woken, eventType: 'thread_message', messageId: MESSAGE, taskEventId: EVENT,
    }).success,
    false,
  )
  assert.equal(
    TicketTriggerDeliveryPayloadSchema.safeParse({ ...woken, eventType: 'comment_added', messageId: MESSAGE }).success,
    false,
  )
})
