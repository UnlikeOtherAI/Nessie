import assert from 'node:assert/strict'
import test from 'node:test'

import { TicketWorkActivityPayloadSchema, TICKET_WORK_ACTIVITY_EVENT_TYPES } from '../task-events.js'
import { TicketWorkKickoffMetadataSchema, TicketWorkThreadEventSchema } from '../ticket-work-thread.js'

const WORK = '6a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'
const AGENT = '7b2c3d4e-5f6a-4b7c-9d8e-0f1a2b3c4d5e'

test('a thread row is woken by a wake reason or stopped by a state reason, and nothing else', () => {
  assert.equal(TicketWorkThreadEventSchema.safeParse({
    kind: 'woken', workId: WORK, reason: 'ticket_commented', summary: 'Ondrej commented',
  }).success, true)
  assert.equal(TicketWorkThreadEventSchema.safeParse({
    kind: 'stopped', workId: WORK, reason: 'limit_wakes', summary: '30 wakes used',
  }).success, true)
  // A wake reason is not a reason to stop, and the reverse.
  assert.equal(TicketWorkThreadEventSchema.safeParse({
    kind: 'stopped', workId: WORK, reason: 'ticket_commented', summary: 'x',
  }).success, false)
  assert.equal(TicketWorkThreadEventSchema.safeParse({
    kind: 'woken', workId: WORK, reason: 'limit_wakes', summary: 'x',
  }).success, false)
  // A kickoff lists at least one event.
  assert.equal(TicketWorkKickoffMetadataSchema.safeParse({ workId: WORK, events: [] }).success, false)
})

test('a work row in the ticket history is the platform\'s, and names who caused it when someone did', () => {
  assert.deepEqual([...TICKET_WORK_ACTIVITY_EVENT_TYPES], [
    'work_started', 'work_queued', 'work_paused', 'work_resumed', 'work_ended',
  ])
  const ended = {
    origin: { kind: 'system' }, workId: WORK, triggerId: null, agentId: AGENT, status: 'failed', reason: 'limit_wakes',
  }
  assert.equal(TicketWorkActivityPayloadSchema.safeParse(ended).success, true)
  assert.equal(TicketWorkActivityPayloadSchema.safeParse({ ...ended, by: `agent:${AGENT}` }).success, true)
  assert.equal(TicketWorkActivityPayloadSchema.safeParse({ ...ended, origin: { kind: 'session' } }).success, false)
  assert.equal(TicketWorkActivityPayloadSchema.safeParse({ ...ended, reason: 'because' }).success, false)
})
