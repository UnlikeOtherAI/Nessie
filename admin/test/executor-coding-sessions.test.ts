import assert from 'node:assert/strict'
import test from 'node:test'

import { executorObservedAge } from '../src/components/features/executors/executor-presentation'
import { EXECUTOR_CODING_SESSIONS_RECHECK_MS } from '../src/facades/executors/coding-sessions'

test('the open list follows the machine’s report at the heartbeat’s pace', () => {
  // The rows are the last local-MCP report, which any heartbeat may replace.
  assert.equal(EXECUTOR_CODING_SESSIONS_RECHECK_MS, 20_000, 'the daemon heartbeats every 20 s')
})

test('a reported time reads as its age, and an unreadable one says so rather than guessing', () => {
  const now = Date.parse('2026-09-23T20:00:00.000Z')
  assert.equal(executorObservedAge('2026-09-23T19:59:30.000Z', now), 'just now')
  assert.equal(executorObservedAge('2026-09-23T19:55:00.000Z', now), '5 min ago')
  assert.equal(executorObservedAge('2026-09-23T17:00:00.000Z', now), '3 h ago')
  assert.equal(executorObservedAge('2026-09-20T20:00:00.000Z', now), '3 d ago')
  assert.equal(executorObservedAge('not a time', now), 'at an unreadable time')
  // Counted from each re-read, so an open section's ages move on as it is read again.
  const updatedAt = '2026-09-23T19:59:30.000Z'
  assert.equal(executorObservedAge(updatedAt, now + 5 * 60_000), '6 min ago')
})
