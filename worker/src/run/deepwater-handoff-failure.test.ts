import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createDeepWaterHandoffGuardForTest,
  DeepWaterHandoffAmbiguousStartError,
  DeepWaterHandoffInvariantError,
} from './deepwater-handoff-guard.js'
import {
  makeRepository,
  runningTicket,
  START_ARGS,
} from './deepwater-handoff-guard.test-support.js'
import { promoteUnresolvedDeepWaterHandoffError } from './deepwater-handoff-failure.js'

test('execute-run promotes an inference throw before research_start to fatal retry', async () => {
  const { repository } = makeRepository()
  const guard = await createDeepWaterHandoffGuardForTest(repository)
  const inferenceError = new Error('provider failed before tool selection')

  const promoted = promoteUnresolvedDeepWaterHandoffError(
    inferenceError,
    guard,
  )

  assert.ok(promoted instanceof DeepWaterHandoffInvariantError)
  assert.equal(promoted.handoffRunId, 'handoff-run-1')
})

test('execute-run preserves an ordinary failure after exact ticket delivery', async () => {
  const { repository } = makeRepository()
  const guard = await createDeepWaterHandoffGuardForTest(repository)
  const started = await guard.dispatchDeepWater(
    'research_start',
    'tool-call-1',
    START_ARGS,
    async () => runningTicket('rs_delivered'),
  )
  assert.ok(started.deliveryToken)
  guard.markDelivered(started.deliveryToken)
  const laterError = new Error('later response write failed')

  assert.equal(
    promoteUnresolvedDeepWaterHandoffError(laterError, guard),
    laterError,
  )
})

test('execute-run promotes callback failure while ticket delivery is pending', async () => {
  const { repository } = makeRepository()
  const guard = await createDeepWaterHandoffGuardForTest(repository)
  await guard.dispatchDeepWater(
    'research_start',
    'tool-call-1',
    START_ARGS,
    async () => runningTicket('rs_pending_delivery'),
  )

  const promoted = promoteUnresolvedDeepWaterHandoffError(
    new Error('tool-end callback failed'),
    guard,
  )
  assert.ok(promoted instanceof DeepWaterHandoffAmbiguousStartError)
  assert.equal(promoted.handoffRunId, 'handoff-run-1')
})
