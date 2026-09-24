import assert from 'node:assert/strict'
import test from 'node:test'

import {
  pullRequestLine,
  ticketWorkLimitsClause,
  ticketWorkMachineLines,
  type TicketWorkMachineFacts,
} from './ticket-work-kickoff-machine.js'

/**
 * The machine half of a kickoff's state block
 * (docs/plans/2026-09-23-ticket-driven-agents/ticket-work.md → "What every
 * wake says"): where the work stands with its machine, its spend, its session
 * and its pull request — never the machine's name.
 */

const base: TicketWorkMachineFacts = {
  limits: null,
  pinned: false,
  policy: null,
  pullRequest: null,
  queuePosition: null,
  sessions: null,
  stateReason: null,
  status: 'active',
}

test('the pull request line says its state and checks, and when they were seen', () => {
  const url = 'https://github.com/unlikeotherai/nessie/pull/142'
  const seenAt = new Date('2026-09-24T15:20:00.000Z')
  assert.equal(pullRequestLine({ ...base, pullRequest: { checks: { failed: 0, passed: 14, pending: 0 }, seenAt, state: 'MERGED', url } }),
    `Pull request: ${url}, MERGED, checks 14 passed (15:20 UTC).`)
  assert.equal(pullRequestLine({ ...base, pullRequest: { checks: { failed: 0, passed: 12, pending: 1 }, seenAt, state: 'OPEN', url } }),
    `Pull request: ${url}, OPEN, checks 12 passed / 0 failed / 1 pending (15:20 UTC).`)
  assert.equal(pullRequestLine(base), 'Pull request: none on record.')
})

test('each place the work can stand with its machine reads as its own line', () => {
  const lines = (facts: Partial<TicketWorkMachineFacts>, ended = false) => ticketWorkMachineLines({ ...base, ...facts }, ended)
  assert.match(lines({ queuePosition: 2, stateReason: 'queued_no_free_machine', status: 'queued' })[0]!,
    /^Machine: none yet — the work is queued at position 2, because every machine is busy/)
  assert.match(lines({ stateReason: 'queued_machines_offline', status: 'queued' })[0]!, /because the machines are offline/)
  assert.match(lines({ stateReason: 'machine_offline', status: 'waiting_machine' })[0]!, /its machine is offline/)
  assert.match(lines({ stateReason: 'machine_access_not_set_up', status: 'waiting_machine' })[0]!,
    /machine access for this trigger is not set up/)
  assert.match(lines({ policy: 'suspended', stateReason: 'machine_access_suspended', status: 'waiting_machine' })[0]!,
    /paused until the machines' owner confirms it again/)
  const working = lines({
    pinned: true, policy: 'live', sessions: [{ sessionId: 's-1', status: 'waiting_for_input', turn: 2 }],
  })
  assert.match(working[0]!, /^Machine: one of its owner's machines is assigned to this work\./)
  assert.equal(working[1], 'Coding session for this ticket: s-1 waiting_for_input, turn 2; no other session belongs to '
    + 'this ticket.')
  assert.deepEqual(lines({ pinned: true, policy: 'live' }, true), ['Machine: none.', 'Pull request: none on record.'])
})

test('the limits clause counts hours and spend against the policy\'s', () => {
  assert.equal(ticketWorkLimitsClause({
    ...base,
    limits: { activeMs: 72 * 60_000, costUsd: 3.1, dailyUsd: 3.1, limits: { dailyUsd: 60, ticketHours: 4, ticketUsd: 20 } },
  }), '1 h 12 min of 4 h, coding cost $3.10 of $20 (as last seen)')
  assert.equal(ticketWorkLimitsClause(base), null)
})
