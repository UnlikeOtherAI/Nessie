import assert from 'node:assert/strict'
import test from 'node:test'

import {
  standingPolicyRefusalSentence,
  type TicketWorkChipRecord,
  type TicketWorkHistoryEntry,
} from '@nessie/schemas'

import {
  ticketDeliveryLine,
  ticketWorkHeadline,
  ticketWorkHistoryLine,
  ticketWorkMachineRefusalLine,
  ticketWorkStateLine,
  ticketWorkWakeLine,
} from '../src/components/features/ticket-work/ticket-work-presentation'

// What the ticket's chip and its work history say of machines (T4,
// docs/plans/2026-09-23-ticket-driven-agents/ticket-work.md → "What the
// project sees"): a place in the queue and why, a machine gone offline,
// machine access not set up, paused or ended, the hours and budget limits,
// and a wake that ran without a machine. None of it names a machine.

const record = (over: Partial<TicketWorkChipRecord>): TicketWorkChipRecord => ({
  agent: { id: 'a1111111-1111-4111-8111-111111111111' as never, name: 'CTO' },
  awaitingAnswerAt: null,
  endedAt: null,
  id: 'w1111111-1111-4111-8111-111111111111',
  lastWakeAt: null,
  lastWakeReason: null,
  pendingReminder: null,
  startedAt: new Date().toISOString(),
  startedByName: 'Ondrej',
  stateReason: null,
  status: 'active',
  thread: null,
  triggerId: 't1111111-1111-4111-8111-111111111111',
  wakeCount: 3,
  wakeLimit: 30,
  ...over,
})

const REMEDY = 'Move the ticket out of and back into a start-work column to continue.'

test('queued work says its place in the queue and why it waits', () => {
  const queued = record({ queuePosition: 2, stateReason: 'queued_no_free_machine', status: 'queued' })
  assert.equal(ticketWorkStateLine(queued), 'Queued: position 2 — every machine is busy.')
  assert.equal(
    ticketWorkStateLine({ ...queued, stateReason: 'queued_machines_offline' }),
    'Queued: position 2 — the machines are offline.',
  )
  // Without a position it still says why, and without a reason it still says what.
  assert.equal(ticketWorkStateLine({ ...queued, queuePosition: null }), 'Queued: every machine is busy.')
  assert.equal(ticketWorkStateLine({ ...queued, queuePosition: undefined, stateReason: null }), 'Queued for a machine.')
  assert.equal(ticketWorkStateLine({ ...queued, stateReason: null }), 'Queued: position 2.')
  assert.match(ticketWorkHeadline(queued), /^CTO · queued · started /)
})

test('work waiting for a machine says what it waits on and what ends the wait', () => {
  const waiting = record({ status: 'waiting_machine' })
  assert.equal(
    ticketWorkStateLine({ ...waiting, stateReason: 'machine_offline' }),
    'Paused: the machine is offline. Work resumes when it reconnects.',
  )
  assert.equal(
    ticketWorkStateLine({ ...waiting, stateReason: 'machine_access_not_set_up' }),
    'Waiting for machine access: its owner has not set it up yet.',
  )
  assert.equal(
    ticketWorkStateLine({ ...waiting, stateReason: 'machine_access_suspended' }),
    'Waiting for machine access: it is paused until its owner confirms it again.',
  )
  assert.match(ticketWorkHeadline(waiting), /^CTO · waiting for a machine · started /)
})

test('the hours and budget limits stop work with the same remedy as the wake limit', () => {
  const stopped = record({ endedAt: new Date().toISOString(), status: 'failed' })
  assert.equal(
    ticketWorkStateLine({ ...stopped, stateReason: 'limit_hours' }),
    `Stopped: its hours are used up. ${REMEDY}`,
  )
  assert.equal(
    ticketWorkStateLine({ ...stopped, stateReason: 'limit_cost' }),
    `Stopped: its budget is used up. ${REMEDY}`,
  )
  // The wake and daily limits keep their own words.
  assert.equal(
    ticketWorkStateLine({ ...stopped, stateReason: 'limit_wakes', wakeCount: 30 }),
    `Stopped: 30 wakes used. ${REMEDY}`,
  )
  assert.equal(
    ticketWorkStateLine({ ...stopped, stateReason: 'limit_daily' }),
    'Stopped: the trigger started as many tickets today as it may. '
    + 'Move the ticket out of and back into a start-work column to try again.',
  )
})

test('work whose machine access ended says so, with no time in the way', () => {
  assert.equal(
    ticketWorkStateLine(record({
      endedAt: new Date().toISOString(), stateReason: 'machine_access_ended', status: 'cancelled',
    })),
    'Ended: its machine access ended.',
  )
})

test('a wake that ran without a machine is said on live work, in the sentence the run was told', () => {
  const sentence = standingPolicyRefusalSentence('machine_unavailable')
  const refusal = { at: new Date().toISOString(), reason: 'machine_unavailable' as const, sentence }
  assert.equal(
    ticketWorkMachineRefusalLine(record({ machineRefusal: refusal })),
    'Ran without a machine: the machine was offline or no longer offers its coding tools.',
  )
  assert.equal(ticketWorkMachineRefusalLine(record({ machineRefusal: refusal, status: 'queued' })), sentence)
  // Ended work, and work with no refusal, show nothing.
  assert.equal(ticketWorkMachineRefusalLine(record({ machineRefusal: refusal, status: 'done' })), null)
  assert.equal(ticketWorkMachineRefusalLine(record({ machineRefusal: null })), null)
  assert.equal(ticketWorkMachineRefusalLine(record({})), null)
})

const entry = (over: Partial<TicketWorkHistoryEntry>): TicketWorkHistoryEntry => ({
  agentName: 'CTO',
  at: new Date().toISOString(),
  byName: null,
  eventType: 'work_started',
  id: 'e1',
  reason: null,
  status: 'active',
  ...over,
})
const said = (over: Partial<TicketWorkHistoryEntry>): string => ticketWorkHistoryLine(entry(over)).split(' · ')[1] ?? ''

test('a history row says a machine pause, a resume and a queue in words', () => {
  assert.equal(
    said({ eventType: 'work_paused', reason: 'machine_offline', status: 'waiting_machine' }),
    'CTO paused the work: the machine is offline',
  )
  assert.equal(
    said({ eventType: 'work_paused', reason: 'machine_access_suspended', status: 'waiting_machine' }),
    'CTO paused the work: machine access is paused',
  )
  // The park in review keeps its own words.
  assert.equal(
    said({ eventType: 'work_paused', status: 'parked' }),
    'CTO parked the work while the ticket is in review',
  )

  assert.equal(said({ eventType: 'work_resumed' }), 'CTO resumed the work')
  assert.equal(
    said({ eventType: 'work_resumed', reason: 'queued_no_free_machine', status: 'queued' }),
    'CTO resumed the work, which is queued for a machine',
  )
  assert.equal(
    said({ eventType: 'work_resumed', reason: 'machine_access_not_set_up', status: 'waiting_machine' }),
    'CTO resumed the work, which waits for machine access',
  )

  assert.equal(
    said({ eventType: 'work_queued', reason: 'queued_no_free_machine', status: 'queued' }),
    'CTO queued the work: every machine is busy',
  )
  assert.equal(
    said({ eventType: 'work_queued', reason: 'queued_machines_offline', status: 'queued' }),
    'CTO queued the work: the machines are offline',
  )
})

test('a history row says where started work went when no machine took it', () => {
  assert.equal(said({}), 'CTO started work')
  assert.equal(
    said({ reason: 'queued_no_free_machine', status: 'queued' }),
    'CTO started work, queued for a machine',
  )
  assert.equal(
    said({ reason: 'machine_access_not_set_up', status: 'waiting_machine' }),
    'CTO started work, waiting for machine access',
  )
  // Who caused it still closes the row.
  assert.match(
    ticketWorkHistoryLine(entry({ byName: 'Ondrej', reason: 'queued_no_free_machine', status: 'queued' })),
    / · CTO started work, queued for a machine · by Ondrej$/,
  )
  assert.equal(
    said({ eventType: 'work_ended', reason: 'machine_access_ended', status: 'cancelled' }),
    'CTO ended the work: machine access ended',
  )
})

test('work paused for an offline machine says since when, and back online says the machine came back (T5)', () => {
  const since = new Date()
  since.setHours(14, 32, 0, 0)
  const paused = record({ machineOfflineSince: since.toISOString(), stateReason: 'machine_offline', status: 'waiting_machine' })
  const clock = since.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  assert.equal(ticketWorkStateLine(paused), `Paused: the machine is offline since ${clock}. Work resumes when it reconnects.`)
  assert.equal(
    said({ eventType: 'work_resumed', previousReason: 'machine_offline', status: 'active' }),
    'CTO resumed the work: its machine is back online',
  )
  assert.equal(
    said({ eventType: 'work_queued', previousReason: 'machine_offline', reason: 'queued_no_free_machine', status: 'queued' }),
    'CTO queued the work for another machine, because its machine stayed offline: every machine is busy',
  )
  // Back at work, the chip says working again, and why it last woke.
  const back = record({ lastWakeAt: new Date().toISOString(), lastWakeReason: 'machine_back_online', status: 'active' })
  assert.match(ticketWorkHeadline(back), /^CTO · working · started /)
  assert.match(ticketWorkWakeLine(back) ?? '', /: the machine came back · wake 3 of 30$/)
  assert.equal(ticketWorkStateLine(back), null)
})

test('a session wake is said on the trigger\'s page, and a skip it did not need says why (T5)', () => {
  const base = {
    originKind: 'system', taskId: 'c1111111-1111-4111-8111-111111111111', workId: 'd1111111-1111-4111-8111-111111111111',
    eventType: 'session',
    session: { sessionId: 'e1111111-1111-4111-8111-111111111111', status: 'waiting_for_input', turn: 4 },
  }
  assert.equal(ticketDeliveryLine({ ...base, outcome: 'follow', wakeReason: 'session_turn_ended' }),
    'Woke the agent: a coding session’s turn ended.')
  assert.equal(ticketDeliveryLine({ ...base, outcome: 'skipped', skipReason: 'no_longer_applies' }),
    'A coding session\'s turn ended, but the agent had already read it, the session had closed or left the ticket by '
      + 'then, or the work was not active, so it was not woken for it.')
  // Only a turn end can have been read already; a close can have been the agent's own, or left behind on
  // a machine the work moved off; any other session can have closed or left the ticket before its wake ran.
  const skipped = (status: string) => ticketDeliveryLine({
    ...base, outcome: 'skipped', skipReason: 'no_longer_applies', session: { ...base.session, status },
  })
  assert.equal(skipped('interrupted'), 'A coding session was interrupted, but it had closed or left the ticket by then, '
    + 'or its work was not active, so the agent was not woken for it.')
  assert.equal(skipped('failed'), 'A coding session failed, but it had closed or left the ticket by then, or its work '
    + 'was not active, so the agent was not woken for it.')
  assert.equal(skipped('closed'), 'A coding session closed, but the agent had closed it itself, the work had moved to '
    + 'another machine, or the work was not active, so it was not woken for it.')
  assert.equal(ticketDeliveryLine({
    originKind: 'system', taskId: base.taskId, workId: base.workId,
    eventType: 'machine_back_online', outcome: 'follow', wakeReason: 'machine_back_online',
  }), 'Woke the agent: the machine came back.')
})
