import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createDeepWaterHandoffGuardForTest,
  DeepWaterHandoffAmbiguousStartError,
  DeepWaterHandoffInvariantError,
} from './deepwater-handoff-guard.js'
import {
  errorResult,
  found,
  handoffRun,
  makeRepository,
  runningTicket,
  START_ARGS,
  ticketResult,
} from './deepwater-handoff-guard.test-support.js'

test('ambiguous recovery reuses the exact persisted tool id and arguments', async () => {
  const persistedArgs = { query: 'Original query', depth: 'standard' }
  const { calls, repository } = makeRepository({
    findRun: async () => found(handoffRun({
      failureEligible: true,
      startArguments: persistedArgs,
      startEligible: false,
      startToolCallId: 'stable-call',
      status: 'running',
    })),
  })
  const guard = await createDeepWaterHandoffGuardForTest(repository)
  const result = await guard.dispatchDeepWater(
    'research_start',
    'new-model-call',
    { query: 'Changed query', depth: 'deep' },
    async (toolCallId, args) => {
      assert.equal(toolCallId, 'stable-call')
      assert.deepEqual(args, persistedArgs)
      return runningTicket('rs_recovered')
    },
  )

  assert.equal(result.result.success, true)
  assert.equal(calls.claim, 0)
  assert.equal(calls.persist, 1)
  assert.ok(result.deliveryToken)
  guard.markDelivered(result.deliveryToken)
})

test('persisted running ticket is replayed locally after a crash', async () => {
  const { repository } = makeRepository({
    findRun: async () => found(handoffRun({
      externalRunId: 'rs_persisted',
      failureEligible: false,
      startArguments: START_ARGS,
      startEligible: false,
      startTicketStatus: 'running',
      startToolCallId: 'stable-call',
      status: 'running',
    })),
  })
  const guard = await createDeepWaterHandoffGuardForTest(repository)
  let dispatches = 0
  const result = await guard.dispatchDeepWater(
    'research_start',
    'new-model-call',
    { query: 'Changed' },
    async () => {
      dispatches += 1
      return runningTicket('rs_wrong')
    },
  )

  assert.equal(result.transportInvoked, false)
  assert.deepEqual(
    (result.result.raw as { structuredContent: unknown }).structuredContent,
    { id: 'rs_persisted', job_id: 'rs_persisted', status: 'running' },
  )
  assert.equal(dispatches, 0)
  assert.ok(result.deliveryToken)
  guard.markDelivered(result.deliveryToken)
  assert.equal(await guard.suppressBuiltin('deep_water_run_update'), false)
  assert.doesNotThrow(() => guard.assertCompletion())
})

test('terminal replay preserves the exact Ledger ticket status', async () => {
  const { repository } = makeRepository({
    findRun: async () => found(handoffRun({
      externalRunId: 'rs_failed',
      failureEligible: false,
      startArguments: START_ARGS,
      startEligible: false,
      startTicketStatus: 'failed',
      startToolCallId: 'stable-call',
      status: 'running',
    })),
  })
  const guard = await createDeepWaterHandoffGuardForTest(repository)
  const result = await guard.dispatchDeepWater(
    'research_start',
    'new-call',
    START_ARGS,
    async () => {
      throw new Error('terminal replay must not use transport')
    },
  )

  assert.deepEqual(
    (result.result.raw as { structuredContent: unknown }).structuredContent,
    { id: 'rs_failed', job_id: 'rs_failed', status: 'failed' },
  )
  assert.ok(result.deliveryToken)
  guard.markDelivered(result.deliveryToken)
  assert.doesNotThrow(() => guard.assertCompletion())
})

test('claim response uncertainty is fatal and never marks the clean row failed', async () => {
  const { calls, repository } = makeRepository({
    claimStart: async () => { throw new Error('claim response lost') },
  })
  const guard = await createDeepWaterHandoffGuardForTest(repository)
  let dispatches = 0
  await assert.rejects(
    guard.dispatchDeepWater(
      'research_start',
      'tool-call-1',
      START_ARGS,
      async () => {
        dispatches += 1
        return runningTicket('rs_never')
      },
    ),
    DeepWaterHandoffInvariantError,
  )

  assert.equal(calls.fail, 0)
  assert.equal(dispatches, 0)
})

test('timeout abandons the attempt and blocks late same-batch dependents', async () => {
  const { repository } = makeRepository()
  const guard = await createDeepWaterHandoffGuardForTest(repository)
  let release: (() => void) | undefined
  let entered: (() => void) | undefined
  const dispatchEntered = new Promise<void>((resolve) => { entered = resolve })
  const start = guard.dispatchDeepWater(
    'research_start',
    'tool-call-1',
    START_ARGS,
    async () => {
      entered?.()
      await new Promise<void>((resolve) => { release = resolve })
      return runningTicket('rs_ticket')
    },
  )
  await dispatchEntered

  let dependentDispatches = 0
  const dependent = guard.dispatchDeepWater(
    'research_status',
    'status-call',
    { id: 'rs_ticket' },
    async () => {
      dependentDispatches += 1
      return ticketResult({ status: 'running' })
    },
  )
  assert.ok(
    guard.timeoutErrorFor('research_start')
      instanceof DeepWaterHandoffAmbiguousStartError,
  )
  assert.equal(guard.timeoutErrorFor('research_status'), null)
  assert.equal((await dependent).transportInvoked, false)
  release?.()
  await start
  assert.equal(dependentDispatches, 0)
  assert.equal(await guard.suppressBuiltin('deep_water_run_update'), true)
  assert.throws(() => guard.assertCompletion(), DeepWaterHandoffAmbiguousStartError)
})

test('a timeout while definitive failure persistence is pending stays fatal', async () => {
  let releaseFailure: (() => void) | undefined
  let failureEntered: (() => void) | undefined
  const entered = new Promise<void>((resolve) => { failureEntered = resolve })
  const { repository } = makeRepository({
    failStart: async () => {
      failureEntered?.()
      await new Promise<void>((resolve) => { releaseFailure = resolve })
      return true
    },
  })
  const guard = await createDeepWaterHandoffGuardForTest(repository)
  const start = guard.dispatchDeepWater(
    'research_start',
    'tool-call-1',
    START_ARGS,
    async () => errorResult('budget_exceeded', 402),
  )
  await entered

  assert.ok(
    guard.timeoutErrorFor('research_start')
      instanceof DeepWaterHandoffAmbiguousStartError,
  )
  releaseFailure?.()
  await start
  assert.throws(() => guard.assertCompletion(), DeepWaterHandoffAmbiguousStartError)
})

test('persisted ticket stays fatal until its exact result is delivered', async () => {
  const { repository } = makeRepository()
  const guard = await createDeepWaterHandoffGuardForTest(repository)
  const result = await guard.dispatchDeepWater(
    'research_start',
    'tool-call-1',
    START_ARGS,
    async () => runningTicket('rs_persisted'),
  )

  assert.ok(result.deliveryToken)
  guard.markDelivered(Symbol('unrelated-delivery'))
  assert.ok(
    guard.timeoutErrorFor('research_start')
      instanceof DeepWaterHandoffAmbiguousStartError,
  )

  const replayRepository = makeRepository({
    findRun: async () => found(handoffRun({
      externalRunId: 'rs_persisted',
      failureEligible: false,
      startArguments: START_ARGS,
      startEligible: false,
      startTicketStatus: 'running',
      startToolCallId: 'tool-call-1',
      status: 'running',
    })),
  }).repository
  const replayGuard = await createDeepWaterHandoffGuardForTest(replayRepository)
  const replay = await replayGuard.dispatchDeepWater(
    'research_start',
    'new-model-call',
    START_ARGS,
    async () => {
      throw new Error('persisted ticket must replay locally')
    },
  )
  assert.equal(replay.transportInvoked, false)
  assert.ok(replay.deliveryToken)
  replayGuard.markDelivered(replay.deliveryToken)
  assert.doesNotThrow(() => replayGuard.assertCompletion())
})

test('same-batch follow-ups are pinned to the new ticket and list stays blocked', async () => {
  const { repository } = makeRepository()
  const guard = await createDeepWaterHandoffGuardForTest(repository)
  let releaseStart: (() => void) | undefined
  let startEntered: (() => void) | undefined
  const entered = new Promise<void>((resolve) => { startEntered = resolve })
  const start = guard.dispatchDeepWater(
    'research_start',
    'start-call',
    START_ARGS,
    async () => {
      startEntered?.()
      await new Promise<void>((resolve) => { releaseStart = resolve })
      return runningTicket('rs_new')
    },
  )
  await entered

  const seen: Array<{ args: Record<string, unknown>; callId: string }> = []
  const status = guard.dispatchDeepWater(
    'research_status',
    'status-call',
    { id: 'rs_old' },
    async (callId, args) => {
      seen.push({ args, callId })
      return ticketResult({ id: 'rs_new', status: 'running' })
    },
  )
  const cancel = guard.dispatchDeepWater(
    'research_cancel',
    'cancel-call',
    { id: 'rs_guessed' },
    async (callId, args) => {
      seen.push({ args, callId })
      return ticketResult({ id: 'rs_new', status: 'cancelled' })
    },
  )
  let listDispatches = 0
  const list = await guard.dispatchDeepWater(
    'research_list',
    'list-call',
    { limit: 100 },
    async () => {
      listDispatches += 1
      return ticketResult({ jobs: [] })
    },
  )

  releaseStart?.()
  const [started, statusResult, cancelResult] = await Promise.all([
    start,
    status,
    cancel,
  ])
  assert.deepEqual(seen, [
    { args: { id: 'rs_new' }, callId: 'status-call' },
    { args: { id: 'rs_new' }, callId: 'cancel-call' },
  ])
  assert.equal(statusResult.transportInvoked, true)
  assert.equal(cancelResult.transportInvoked, true)
  assert.equal(list.transportInvoked, false)
  assert.equal(listDispatches, 0)
  assert.ok(started.deliveryToken)
  guard.markDelivered(started.deliveryToken)
  assert.doesNotThrow(() => guard.assertCompletion())
})

test('malformed persisted external id fails closed', async () => {
  const { repository } = makeRepository({
    findRun: async () => found(handoffRun({
      externalRunId: 'untrusted-ticket',
      failureEligible: false,
      startEligible: false,
      status: 'running',
    })),
  })

  await assert.rejects(
    createDeepWaterHandoffGuardForTest(repository),
    DeepWaterHandoffInvariantError,
  )
})
