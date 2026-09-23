import assert from 'node:assert/strict'
import test from 'node:test'

import { ExecutorCodingSessionRecordSchema, type ExecutorCodingSessionRecord } from '@nessie/schemas'

import { executorObservedAge } from '../src/components/features/executors/executor-presentation'
import {
  EXECUTOR_CODING_SESSION_CLOSING_RECHECK_MS,
  executorCodingSessionsRecheckDelay,
} from '../src/facades/executors/coding-sessions'

const session = (closing: boolean): ExecutorCodingSessionRecord => ExecutorCodingSessionRecordSchema.parse({
  agent: 'claude', closing, ownerAgentName: 'CTO', ownerKey: `sha256:${'a'.repeat(64)}`, root: 'nessie',
  sessionId: '00000000-0000-4000-8000-000000000901', status: 'working', title: 'Fix the pricing page',
  updatedAt: '2026-09-23T20:00:00.000Z',
})

test('the list is read again at the heartbeat’s pace only while a Close waits for the machine', () => {
  assert.equal(executorCodingSessionsRecheckDelay(undefined), false)
  assert.equal(executorCodingSessionsRecheckDelay({ sessions: [] }), false, 'nothing open, nothing to wait for')
  assert.equal(executorCodingSessionsRecheckDelay({ sessions: [session(false)] }), false)
  assert.equal(
    executorCodingSessionsRecheckDelay({ sessions: [session(false), session(true)] }),
    EXECUTOR_CODING_SESSION_CLOSING_RECHECK_MS,
  )
  assert.equal(EXECUTOR_CODING_SESSION_CLOSING_RECHECK_MS, 20_000, 'the daemon heartbeats every 20 s')
})

test('a reported time reads as its age, and an unreadable one says so rather than guessing', () => {
  const now = Date.parse('2026-09-23T20:00:00.000Z')
  assert.equal(executorObservedAge('2026-09-23T19:59:30.000Z', now), 'just now')
  assert.equal(executorObservedAge('2026-09-23T19:55:00.000Z', now), '5 min ago')
  assert.equal(executorObservedAge('2026-09-23T17:00:00.000Z', now), '3 h ago')
  assert.equal(executorObservedAge('2026-09-20T20:00:00.000Z', now), '3 d ago')
  assert.equal(executorObservedAge('not a time', now), 'at an unreadable time')
})
