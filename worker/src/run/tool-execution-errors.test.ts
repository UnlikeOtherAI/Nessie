import assert from 'node:assert/strict'
import test from 'node:test'

import {
  FatalToolExecutionError,
  isFinalQueueAttempt,
  shouldRetryRunWithoutTerminalizing,
} from './tool-execution-errors.js'

test('fatal handoff errors leave non-final attempts running for queue retry', () => {
  const error = new FatalToolExecutionError('ambiguous start')

  assert.equal(
    shouldRetryRunWithoutTerminalizing(error, { attempt: 1, maxAttempts: 3 }),
    true,
  )
  assert.equal(isFinalQueueAttempt({ attempt: 1, maxAttempts: 3 }), false)
})

test('final attempts and ordinary failures use terminal run handling', () => {
  const fatal = new FatalToolExecutionError('ambiguous start')

  assert.equal(
    shouldRetryRunWithoutTerminalizing(fatal, { attempt: 3, maxAttempts: 3 }),
    false,
  )
  assert.equal(isFinalQueueAttempt({ attempt: 3, maxAttempts: 3 }), true)
  assert.equal(
    shouldRetryRunWithoutTerminalizing(
      new Error('ordinary failure'),
      { attempt: 1, maxAttempts: 3 },
    ),
    false,
  )
})
