import assert from 'node:assert/strict'
import test from 'node:test'

import type { ExecutorLocalMcpReport } from '@nessie/schemas'

import { liveTicketWorkSessions, ticketWorkSessionOriginsOf } from '../src/ticket-work-session-origins.js'

/**
 * A ticket's live coding sessions (docs/standards/ticket-work-machine-access.md
 * → "Session isolation"): a recorded session is live unless a report the
 * machine took after it was recorded says otherwise, and never on a machine it
 * was not started on.
 */

const MINIS = '00000000-0000-4000-8000-000000000001'
const STUDIO = '00000000-0000-4000-8000-000000000002'
const POLICY = '00000000-0000-4000-8000-000000000003'
const FRESH = '00000000-0000-4000-8000-0000000000f1'
const GONE = '00000000-0000-4000-8000-0000000000f2'
const THERE = '00000000-0000-4000-8000-0000000000f3'
const OLD = '00000000-0000-4000-8000-0000000000f4'
const OLDER = '00000000-0000-4000-8000-0000000000f5'
const BAD = '00000000-0000-4000-8000-0000000000f6'
const GOOD = '00000000-0000-4000-8000-0000000000f7'
const OWNER = `sha256:${'a'.repeat(64)}`
const at = (minutesAgo: number): Date => new Date(Date.parse('2026-09-24T12:00:00.000Z') - minutesAgo * 60_000)

const report = (sessions: Array<{ sessionId: string; status: string }>, observedAt: Date): ExecutorLocalMcpReport => [{
  available: true,
  codingSessions: sessions.map((session) => ({
    agent: 'claude', ownerKey: OWNER, root: 'nessie', sessionId: session.sessionId, status: session.status,
    title: 'Fix login redirect', updatedAt: observedAt.toISOString(),
  })),
  observedAt: observedAt.toISOString(),
  server: 'coding-sessions',
}] as ExecutorLocalMcpReport

const origin = (executorId: string, minutesAgo: number) => ({
  executorId, policyId: POLICY, startedAt: at(minutesAgo).toISOString(),
})

test('a session started after the machine last reported is live until a later report says otherwise', () => {
  const origins = ticketWorkSessionOriginsOf({ [FRESH]: origin(MINIS, 0), [GONE]: origin(MINIS, 10) })
  const reportedAt = at(1)
  const live = liveTicketWorkSessions({
    executorId: MINIS, localMcp: report([], reportedAt), localMcpObservedAt: reportedAt, origins, ownerKey: OWNER,
    sessionIds: [GONE, FRESH],
  })
  // "gone" started before the report and is not in it: closed. "fresh" started after it: live.
  assert.deepEqual(live, [{ sessionId: FRESH, status: 'starting', turn: null }])
  const later = at(-1)
  assert.deepEqual(liveTicketWorkSessions({
    executorId: MINIS, localMcp: report([{ sessionId: FRESH, status: 'closed' }], later), localMcpObservedAt: later,
    origins, ownerKey: OWNER, sessionIds: [GONE, FRESH],
  }), [], 'a report after it says it closed')
})

test('a session is live only on the machine it was started on', () => {
  const origins = ticketWorkSessionOriginsOf({ [THERE]: origin(STUDIO, 0) })
  assert.deepEqual(liveTicketWorkSessions({
    executorId: MINIS, localMcp: null, localMcpObservedAt: null, origins, ownerKey: OWNER, sessionIds: [THERE],
  }), [])
})

test('an unreadable origin is as if absent, and a session from before origins follows the report', () => {
  assert.deepEqual(ticketWorkSessionOriginsOf({ [BAD]: { executorId: 'nope' }, [GOOD]: origin(MINIS, 0) }),
    { [GOOD]: origin(MINIS, 0) })
  const reportedAt = at(1)
  assert.deepEqual(liveTicketWorkSessions({
    executorId: MINIS, localMcp: report([{ sessionId: OLD, status: 'waiting_for_input' }], reportedAt),
    localMcpObservedAt: reportedAt, origins: {}, ownerKey: OWNER, sessionIds: [OLD, OLDER],
  }), [{ sessionId: OLD, status: 'waiting_for_input', turn: null }])
})

test('a heartbeat whose bridge went unasked reads the sessions as of the last one that asked it (T5)', () => {
  // The bridge was read ten minutes ago; the heartbeat carrying those sessions forward arrived a minute ago.
  const origins = ticketWorkSessionOriginsOf({ [FRESH]: origin(MINIS, 5) })
  const carried = report([], at(10))
  assert.deepEqual(liveTicketWorkSessions({
    executorId: MINIS, localMcp: carried, localMcpObservedAt: at(1), origins, ownerKey: OWNER, sessionIds: [FRESH],
  }), [{ sessionId: FRESH, status: 'starting', turn: null }], 'started after the bridge was last read: still live')
})
