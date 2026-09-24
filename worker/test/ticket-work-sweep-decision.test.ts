import assert from 'node:assert/strict'
import test from 'node:test'

import { decideTicketWorkSweep, type SweepRecordFacts } from '../src/control/ticket-work-sweep.js'

// What `ticket-work.sweep` does with one live record, from its facts alone
// (docs/standards/ticket-work.md → "Reminders, the quiet wake and the sweep").

const NOW = new Date('2026-09-24T14:35:00Z')
const minutesAgo = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000)

const quiet: SweepRecordFacts = {
  status: 'active',
  wakeCount: 3,
  wakeLimit: 30,
  lastWakeAt: minutesAgo(31),
  startedAt: minutesAgo(120),
  awaitingAnswerAt: null,
  pendingReminders: 0,
  quietWakeMinutes: 30,
}

test('active work with nothing scheduled for its quiet minutes gets a quiet wake', () => {
  assert.equal(decideTicketWorkSweep(quiet, NOW), 'quiet')
  assert.equal(decideTicketWorkSweep({ ...quiet, lastWakeAt: minutesAgo(30) }, NOW), 'quiet', 'exactly the minutes')
  assert.equal(decideTicketWorkSweep({ ...quiet, lastWakeAt: minutesAgo(29) }, NOW), null)
  // Never woken since it started: the start is the last thing that happened.
  assert.equal(decideTicketWorkSweep({ ...quiet, lastWakeAt: null, startedAt: minutesAgo(45) }, NOW), 'quiet')
  assert.equal(decideTicketWorkSweep({ ...quiet, lastWakeAt: null, startedAt: minutesAgo(5) }, NOW), null)
})

test('a reminder, an open question, a status other than active, or the option off: no quiet wake', () => {
  assert.equal(decideTicketWorkSweep({ ...quiet, pendingReminders: 1 }, NOW), null)
  assert.equal(decideTicketWorkSweep({ ...quiet, awaitingAnswerAt: minutesAgo(200) }, NOW), null)
  for (const status of ['queued', 'parked', 'waiting_machine']) {
    assert.equal(decideTicketWorkSweep({ ...quiet, status }, NOW), null, status)
  }
  assert.equal(decideTicketWorkSweep({ ...quiet, quietWakeMinutes: null }, NOW), null)
  assert.equal(decideTicketWorkSweep({ ...quiet, quietWakeMinutes: 60 }, NOW), null)
})

test('work over a lowered wake limit ends, whatever its status; at the limit it waits for its next wake', () => {
  assert.equal(decideTicketWorkSweep({ ...quiet, wakeCount: 31 }, NOW), 'over_limit')
  assert.equal(decideTicketWorkSweep({ ...quiet, wakeCount: 12, wakeLimit: 10, status: 'parked' }, NOW), 'over_limit')
  assert.equal(decideTicketWorkSweep({ ...quiet, wakeCount: 30 }, NOW), 'quiet')
})
