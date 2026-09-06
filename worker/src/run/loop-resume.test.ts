import assert from 'node:assert/strict'
import test from 'node:test'

import { createToolExecutionRecorder, type RecordedToolResult } from './loop-resume.js'

// The recorder's durability contract, at the seam where it is easiest to break:
// two tool calls in one batch settle at the same time, so their persists are
// concurrent unless something makes them not be.
//
// `durable` here stands in for the `run_checkpoints` row, and `commitDelays`
// for what two statements on two pool connections actually do — finish in an
// order nobody chose. The persist that takes the longest commits last, and if
// the state it carries was snapshotted before the other record existed, that
// record is gone from the durable row and the tool behind it runs a second time
// on the next re-claim.

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

const recordingHarness = (commitDelays: number[]) => {
  let durable: Record<string, RecordedToolResult> = {}
  let inFlight = 0
  let maxInFlight = 0
  let persists = 0

  const recorder = createToolExecutionRecorder({
    executeTool: async (toolName, _args, toolCallId) => ({
      inputSummary: toolName,
      output: `${toolCallId} ran`,
      success: true,
    }),
    onRecorded: async () => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      // Exactly what `crash-checkpoint.ts` does: read the records as they stand
      // now, then spend a round trip writing them.
      const state = recorder.recorded()
      await delay(commitDelays[persists++] ?? 0)
      durable = state
      inFlight -= 1
    },
  })

  return {
    durable: () => durable,
    maxInFlight: () => maxInFlight,
    persists: () => persists,
    recorder,
  }
}

test('concurrent records all survive in the durable row', async () => {
  // Descending delays: without serialisation the FIRST record's persist is the
  // last to commit, and it carries a state that predates every other record.
  const harness = recordingHarness([40, 30, 20, 0])
  const ids = ['call-1', 'call-2', 'call-3', 'call-4']

  await Promise.all(
    ids.map((toolCallId) => harness.recorder.executeTool('mail_send', {}, toolCallId)),
  )

  assert.deepEqual(
    Object.keys(harness.durable()).sort(),
    ids,
    'after N concurrent records the durable row contains all N',
  )
  assert.equal(
    harness.maxInFlight(),
    1,
    'two persists in flight at once is the reordering hazard itself',
  )
  assert.equal(harness.persists(), ids.length, 'every record is persisted, none coalesced away')
})

test('a failed persist does not stop the next record from persisting', async () => {
  let durable: Record<string, RecordedToolResult> = {}
  let attempts = 0
  const recorder = createToolExecutionRecorder({
    executeTool: async (toolName, _args, toolCallId) => ({
      inputSummary: toolName,
      output: `${toolCallId} ran`,
      success: true,
    }),
    onRecorded: async () => {
      attempts += 1
      const state = recorder.recorded()
      if (attempts === 1) throw new Error('connection reset')
      durable = state
    },
  })

  await assert.rejects(
    () => recorder.executeTool('mail_send', {}, 'call-1'),
    /connection reset/,
    'the caller still sees its own write fail',
  )
  await recorder.executeTool('mail_send', {}, 'call-2')

  assert.equal(attempts, 2)
  assert.deepEqual(
    Object.keys(durable).sort(),
    ['call-1', 'call-2'],
    'the chain carries on, and the later write still carries the earlier record',
  )
})

test('a suspended call is not recorded and does not persist', async () => {
  let persists = 0
  const recorder = createToolExecutionRecorder({
    executeTool: async () => ({
      inputSummary: 'send',
      output: 'Tool execution is waiting for human approval.',
      pendingApproval: { approvalId: 'a-1', notice: 'needs a person', toolName: 'mail_send' },
      success: false,
    }),
    onRecorded: async () => {
      persists += 1
    },
  })

  await recorder.executeTool('mail_send', {}, 'call-1')

  assert.equal(persists, 0)
  assert.deepEqual(recorder.recorded(), {}, 'an approval the run is still waiting for is not a result')
})
