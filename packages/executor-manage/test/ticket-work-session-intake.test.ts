import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import type { ExecutorCodingSessionSummary, ExecutorLocalMcpReport } from '@nessie/schemas'

import { ticketWorkSessionWakes, withLastKnownCodingSessions } from '../src/ticket-work-session-intake.js'

/**
 * The heartbeat intake's decision over two reports (T5;
 * docs/standards/ticket-work-machine-access.md → "A ticket's coding session
 * wakes its work"): which of the sessions a live work record names wake it,
 * and which closed. The transaction around it is exercised against Postgres
 * in the worker's `ticket-work-session-wakes` suite.
 */

const OWNER = `sha256:${'b'.repeat(64)}`

const summary = (sessionId: string, fields: Partial<ExecutorCodingSessionSummary>): ExecutorCodingSessionSummary => ({
  agent: 'claude',
  ownerKey: OWNER,
  root: 'nessie',
  sessionId,
  status: 'working',
  title: 'Fix login redirect',
  updatedAt: new Date().toISOString(),
  ...fields,
})

const decide = (input: {
  named: string[]
  next: ExecutorCodingSessionSummary[] | null
  observed?: Record<string, number>
  previous?: ExecutorCodingSessionSummary[]
}) => ticketWorkSessionWakes({
  named: new Set(input.named),
  next: input.next,
  observed: new Map(Object.entries(input.observed ?? {})),
  previous: input.previous ?? [],
})

test('a turn that began and ended between two reports wakes once, for the new turn', () => {
  const id = randomUUID()
  const fast = decide({
    named: [id],
    previous: [summary(id, { status: 'waiting_for_input', turn: 3 })],
    next: [summary(id, { status: 'waiting_for_input', turn: 4 })],
  })
  assert.deepEqual(fast, { closed: [], wakes: [{ sessionId: id, status: 'waiting_for_input', turn: 4 }] })
  // The same report again changes nothing.
  const repeated = decide({
    named: [id],
    previous: [summary(id, { status: 'waiting_for_input', turn: 4 })],
    next: [summary(id, { status: 'waiting_for_input', turn: 4 })],
  })
  assert.deepEqual(repeated.wakes, [])
})

test('a slow turn wakes when it ends, never while it runs', () => {
  const id = randomUUID()
  assert.deepEqual(decide({
    named: [id],
    previous: [summary(id, { status: 'waiting_for_input', turn: 3 })],
    next: [summary(id, { status: 'working', turn: 4 })],
  }).wakes, [])
  assert.deepEqual(decide({
    named: [id],
    previous: [summary(id, { status: 'working', turn: 4 })],
    next: [summary(id, { status: 'waiting_for_input', turn: 4 })],
  }).wakes, [{ sessionId: id, status: 'waiting_for_input', turn: 4 }])
  // A first report of a session whose first turn already ended.
  assert.deepEqual(decide({ named: [id], next: [summary(id, { status: 'waiting_for_input', turn: 1 })] }).wakes,
    [{ sessionId: id, status: 'waiting_for_input', turn: 1 }])
  assert.deepEqual(decide({ named: [id], next: [summary(id, { status: 'starting', turn: 0 })] }).wakes, [])
})

test('entering interrupted or failed wakes, with its reason; staying there does not', () => {
  const id = randomUUID()
  const interrupted = decide({
    named: [id],
    previous: [summary(id, { status: 'working', turn: 5 })],
    next: [summary(id, { reason: 'max_turn_minutes', status: 'interrupted', turn: 5 })],
  })
  assert.deepEqual(interrupted.wakes, [{ reason: 'max_turn_minutes', sessionId: id, status: 'interrupted', turn: 5 }])
  const failed = decide({
    named: [id],
    previous: [summary(id, { status: 'waiting_for_input', turn: 5 })],
    next: [summary(id, { reason: 'agent_missing', status: 'failed', turn: 5 })],
  })
  assert.deepEqual(failed.wakes, [{ reason: 'agent_missing', sessionId: id, status: 'failed', turn: 5 }])
  assert.deepEqual(decide({
    named: [id],
    previous: [summary(id, { status: 'failed', turn: 5 })],
    next: [summary(id, { status: 'failed', turn: 5 })],
  }).wakes, [])
})

test('a session missing from a report that could list it closed; at the row cap it is unknown', () => {
  const id = randomUUID()
  const others = (count: number) => Array.from({ length: count }, () => summary(randomUUID(), { turn: 1 }))
  const gone = decide({
    named: [id],
    previous: [summary(id, { status: 'waiting_for_input', turn: 2 }), ...others(3)],
    next: others(3),
  })
  assert.deepEqual(gone, { closed: [id], wakes: [{ sessionId: id, status: 'closed', turn: 2 }] })
  const capped = decide({
    named: [id],
    previous: [summary(id, { status: 'waiting_for_input', turn: 2 }), ...others(31)],
    next: others(32),
  })
  assert.deepEqual(capped, { closed: [], wakes: [] }, 'a list cut at 32 proves nothing by what it leaves out')
  // Never listed on this machine: a start the report was taken before, not a close.
  assert.deepEqual(decide({ named: [id], next: others(2) }), { closed: [], wakes: [] })
  // A session that says it closed, closed.
  assert.deepEqual(decide({
    named: [id],
    previous: [summary(id, { status: 'waiting_for_input', turn: 2 })],
    next: [summary(id, { status: 'closed', turn: 2 })],
  }), { closed: [id], wakes: [{ sessionId: id, status: 'closed', turn: 2 }] })
})

test('a report without the field infers nothing; an older daemon\'s turnless summary wakes no turn', () => {
  const id = randomUUID()
  assert.deepEqual(decide({
    named: [id], previous: [summary(id, { status: 'waiting_for_input', turn: 2 })], next: null,
  }), { closed: [], wakes: [] })
  assert.deepEqual(decide({
    named: [id], previous: [summary(id, { status: 'working' })], next: [summary(id, { status: 'waiting_for_input' })],
  }).wakes, [])
})

test('a turn the agent already saw end is the baseline when the machine never listed the session before', () => {
  const id = randomUUID()
  assert.deepEqual(decide({
    named: [id], observed: { [id]: 4 }, next: [summary(id, { status: 'waiting_for_input', turn: 4 })],
  }).wakes, [])
  assert.deepEqual(decide({
    named: [id], observed: { [id]: 4 }, next: [summary(id, { status: 'waiting_for_input', turn: 5 })],
  }).wakes, [{ sessionId: id, status: 'waiting_for_input', turn: 5 }])
  // Sessions no live record names are not read at all.
  assert.deepEqual(decide({ named: [], next: [summary(id, { status: 'waiting_for_input', turn: 9 })] }).wakes, [])
})

test('a report whose bridge went unasked is stored with the last sessions, as of when they were read', () => {
  const session = { agent: 'claude', ownerKey: `sha256:${'a'.repeat(64)}`, root: 'nessie', sessionId: randomUUID(),
    status: 'working', title: 'Fix login redirect', updatedAt: '2026-09-24T11:50:00.000Z' }
  const stored = [{ available: true, codingSessions: [session], observedAt: '2026-09-24T11:50:00.000Z',
    server: 'coding-sessions' }]
  const next = [
    { available: true, observedAt: '2026-09-24T11:59:00.000Z', server: 'coding-sessions' },
  ] as ExecutorLocalMcpReport
  assert.deepEqual(withLastKnownCodingSessions(stored, next), [{
    available: true, codingSessions: [session], observedAt: '2026-09-24T11:50:00.000Z', server: 'coding-sessions',
  }])
  // A report that asked the bridge is stored as it came.
  const asked = [{ ...next[0]!, codingSessions: [] }] as ExecutorLocalMcpReport
  assert.deepEqual(withLastKnownCodingSessions(stored, asked), asked)
})
