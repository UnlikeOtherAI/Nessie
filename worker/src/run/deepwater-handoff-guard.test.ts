import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEEP_WATER_START_FAILURE_DETAIL,
} from '@nessie/runtime'

import {
  createDeepWaterHandoffGuardForTest,
  DeepWaterHandoffAmbiguousStartError,
  DeepWaterHandoffInvariantError,
} from './deepwater-handoff-guard.js'
import {
  errorResult,
  makeRepository,
  runningTicket,
  START_ARGS,
  ticketResult,
} from './deepwater-handoff-guard.test-support.js'
import type { ToolDispatchResult } from './tool-dispatch.js'

test('validated Ledger-local rejection fails once and suppresses dependent work', async () => {
  const { calls, repository } = makeRepository()
  const guard = await createDeepWaterHandoffGuardForTest(repository)
  const result = await guard.dispatchDeepWater(
    'research_start',
    'tool-call-1',
    START_ARGS,
    async () => errorResult('budget_exceeded', 402),
  )

  assert.equal(result.result.output, DEEP_WATER_START_FAILURE_DETAIL)
  assert.equal(result.transportInvoked, true)
  assert.equal(calls.claim, 1)
  assert.equal(calls.fail, 1)
  assert.equal(calls.persist, 0)
  assert.equal(await guard.suppressBuiltin('deep_water_run_update'), true)
  assert.equal(await guard.suppressBuiltin('kb_draft_write'), true)
  assert.equal(await guard.suppressBuiltin('delegate'), true)
  assert.ok(result.deliveryToken)
  guard.markDelivered(result.deliveryToken)
  assert.doesNotThrow(() => guard.assertCompletion())
})

test('Ledger 5xx, conflict, upstream rejection, and malformed errors stay ambiguous', async () => {
  for (const result of [
    errorResult('upstream_unavailable', 500),
    errorResult('conflict', 409),
    errorResult('upstream_rejected', 400),
    { output: 'malformed', raw: { isError: true }, success: false },
  ] satisfies ToolDispatchResult[]) {
    const { calls, repository } = makeRepository()
    const guard = await createDeepWaterHandoffGuardForTest(repository)

    await assert.rejects(
      guard.dispatchDeepWater(
        'research_start',
        'tool-call-1',
        START_ARGS,
        async () => result,
      ),
      DeepWaterHandoffAmbiguousStartError,
    )
    assert.equal(calls.fail, 0)
    assert.throws(() => guard.assertCompletion(), DeepWaterHandoffAmbiguousStartError)
  }
})

test('thrown transport outcome stays ambiguous and is never marked failed', async () => {
  const { calls, repository } = makeRepository()
  const guard = await createDeepWaterHandoffGuardForTest(repository)

  await assert.rejects(
    guard.dispatchDeepWater(
      'research_start',
      'tool-call-1',
      START_ARGS,
      async () => { throw new Error('response lost') },
    ),
    DeepWaterHandoffAmbiguousStartError,
  )
  assert.equal(calls.claim, 1)
  assert.equal(calls.fail, 0)
  assert.equal(await guard.suppressBuiltin('kb_draft_write'), true)
  assert.throws(() => guard.assertCompletion(), DeepWaterHandoffAmbiguousStartError)
})

test('malformed successful tickets stay ambiguous instead of recording false failure', async () => {
  for (const malformed of [
    { id: 'rs_missing_job_id', status: 'running' },
    { id: 'rs_missing_status', job_id: 'rs_missing_status' },
    { id: 'rs_invalid_status', job_id: 'rs_invalid_status', status: 'queued' },
  ]) {
    const { calls, repository } = makeRepository()
    const guard = await createDeepWaterHandoffGuardForTest(repository)
    await assert.rejects(
      guard.dispatchDeepWater(
        'research_start',
        'tool-call-1',
        START_ARGS,
        async () => ticketResult(malformed),
      ),
      DeepWaterHandoffAmbiguousStartError,
    )
    assert.equal(calls.fail, 0)
    assert.equal(calls.persist, 0)
    assert.throws(
      () => guard.assertCompletion(),
      DeepWaterHandoffAmbiguousStartError,
    )
  }
})

test('validated ticket is durably persisted before successful pass-through', async () => {
  const events: string[] = []
  const { calls, repository } = makeRepository({
    claimStart: async (_runId, toolCallId, args) => {
      assert.equal(toolCallId, 'tool-call-1')
      assert.deepEqual(args, START_ARGS)
      events.push('claim')
      return true
    },
    persistTicket: async (_runId, toolCallId, externalRunId, ticketStatus) => {
      assert.equal(toolCallId, 'tool-call-1')
      assert.equal(externalRunId, 'rs_ticket-123')
      assert.equal(ticketStatus, 'running')
      events.push('persist')
      return true
    },
  })
  const guard = await createDeepWaterHandoffGuardForTest(repository)
  const expected = runningTicket('rs_ticket-123')
  const result = await guard.dispatchDeepWater(
    'research_start',
    'tool-call-1',
    START_ARGS,
    async () => {
      events.push('dispatch')
      return expected
    },
  )

  assert.equal(result.result, expected)
  assert.deepEqual(events, ['claim', 'dispatch', 'persist'])
  assert.equal(calls.fail, 0)
  assert.equal(await guard.suppressBuiltin('kb_draft_write'), true)
  assert.ok(result.deliveryToken)
  guard.markDelivered(result.deliveryToken)
  assert.equal(await guard.suppressBuiltin('kb_draft_write'), false)
  assert.doesNotThrow(() => guard.assertCompletion())
})

test('ticket persistence failure is a fatal invariant, not a model-visible tool error', async () => {
  const { repository } = makeRepository({ persistTicket: async () => false })
  const guard = await createDeepWaterHandoffGuardForTest(repository)

  await assert.rejects(
    guard.dispatchDeepWater(
      'research_start',
      'tool-call-1',
      START_ARGS,
      async () => runningTicket('rs_ticket'),
    ),
    DeepWaterHandoffInvariantError,
  )
})

test('ordinary DeepWater calls without a handoff remain unchanged', async () => {
  const { repository } = makeRepository({ findRun: async () => ({ kind: 'none' }) })
  const guard = await createDeepWaterHandoffGuardForTest(repository)
  const expected = ticketResult({ message: 'ordinary response' })
  const result = await guard.dispatchDeepWater(
    'research_start',
    'ordinary-call',
    START_ARGS,
    async (toolCallId, args) => {
      assert.equal(toolCallId, 'ordinary-call')
      assert.deepEqual(args, START_ARGS)
      return expected
    },
  )

  assert.equal(result.result, expected)
  assert.equal(await guard.suppressBuiltin('delegate'), false)
  assert.equal(guard.timeoutErrorFor('research_start'), null)
  assert.doesNotThrow(() => guard.assertCompletion())
})

test('a marked handoff with no exact durable row fails closed', async () => {
  const { repository } = makeRepository({ findRun: async () => ({ kind: 'none' }) })

  await assert.rejects(
    createDeepWaterHandoffGuardForTest(repository, 'handoff-run-1'),
    (error: unknown) =>
      error instanceof DeepWaterHandoffInvariantError
      && error.handoffRunId === 'handoff-run-1',
  )
})

test('a marked handoff retries when its exact durable lookup is uncertain', async () => {
  const { repository } = makeRepository({
    findRun: async () => { throw new Error('database response lost') },
  })

  await assert.rejects(
    createDeepWaterHandoffGuardForTest(repository, 'handoff-run-1'),
    (error: unknown) =>
      error instanceof DeepWaterHandoffInvariantError
      && error.handoffRunId === 'handoff-run-1',
  )
})

test('a marked handoff rejects a mismatched durable row', async () => {
  const { repository } = makeRepository()

  await assert.rejects(
    createDeepWaterHandoffGuardForTest(repository, 'different-run-id'),
    (error: unknown) =>
      error instanceof DeepWaterHandoffInvariantError
      && error.handoffRunId === 'different-run-id',
  )
})

test('ambiguous exact attachment lookup fails closed before inference or transport', async () => {
  const { repository } = makeRepository({
    findRun: async () => ({ kind: 'ambiguous' }),
  })
  await assert.rejects(
    createDeepWaterHandoffGuardForTest(repository),
    DeepWaterHandoffInvariantError,
  )
})

test('queued handoff gates same-batch dependent calls until start succeeds', async () => {
  const { repository } = makeRepository()
  const guard = await createDeepWaterHandoffGuardForTest(repository)
  let dependentDispatches = 0

  assert.equal(await guard.suppressBuiltin('kb_draft_write'), true)
  const earlyStatus = await guard.dispatchDeepWater(
    'research_status',
    'status-call',
    { id: 'rs_unknown' },
    async () => {
      dependentDispatches += 1
      return runningTicket('rs_unknown')
    },
  )
  assert.equal(earlyStatus.transportInvoked, false)

  const started = await guard.dispatchDeepWater(
    'research_start',
    'tool-call-1',
    START_ARGS,
    async () => runningTicket('rs_ticket'),
  )
  assert.ok(started.deliveryToken)
  guard.markDelivered(started.deliveryToken)
  assert.equal(await guard.suppressBuiltin('kb_draft_write'), false)
  assert.equal(dependentDispatches, 0)
})

test('completion fails fatally when the model omits the required start', async () => {
  const { repository } = makeRepository()
  const guard = await createDeepWaterHandoffGuardForTest(repository)

  assert.throws(() => guard.assertCompletion(), DeepWaterHandoffInvariantError)
})
