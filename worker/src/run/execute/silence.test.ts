import assert from 'node:assert/strict'
import test from 'node:test'

import type { RunExecuteJobPayload } from '@nessie/schemas'
import {
  CONCLUDE_SILENTLY_DESCRIPTOR,
  CONCLUDE_SILENTLY_TOOL_NAME,
  createSilenceSink,
  isSilenceEligible,
} from './silence.js'

/**
 * Silence is chosen by the model and observed structurally.
 *
 * The eligibility tests matter most: a run that is answering a person must
 * never be able to come back empty, and the only thing standing between it and
 * that is whether the tool was offered.
 */

const payload = (over: Record<string, unknown> = {}) =>
  ({ interactive: false, ...over }) as unknown as RunExecuteJobPayload

test('a scheduled run may conclude silently', () => {
  assert.equal(isSilenceEligible({ handoffLocator: null, payload: payload() }), true)
})

test('an interactive turn never can — somebody is waiting for an answer', () => {
  assert.equal(
    isSilenceEligible({ handoffLocator: null, payload: payload({ interactive: true }) }),
    false,
  )
})

test('a DeepWater handoff turn never can — its message flow is a fixed contract', () => {
  assert.equal(
    isSilenceEligible({ handoffLocator: { runId: 'r' }, payload: payload() }),
    false,
  )
})

test('a workflow step never can — its parent consumes the response text', () => {
  assert.equal(
    isSilenceEligible({
      handoffLocator: null,
      payload: payload({ parentPlanId: '00000000-0000-4000-8000-000000000001' }),
    }),
    false,
  )
})

test('the sink records the decision and keeps the reason for the run log', () => {
  const sink = createSilenceSink()
  assert.equal(sink.concluded, false)
  assert.equal(sink.reason, null)

  const ack = sink.record({ reason: '  3 open alerts, all already reported  ' })

  assert.equal(sink.concluded, true)
  assert.equal(sink.reason, '3 open alerts, all already reported')
  assert.match(ack, /without posting/i)
})

test('a missing or blank reason still concludes', () => {
  const blank = createSilenceSink()
  blank.record({ reason: '   ' })
  assert.equal(blank.concluded, true)
  assert.equal(blank.reason, null)

  const none = createSilenceSink()
  none.record({})
  assert.equal(none.concluded, true)
  assert.equal(none.reason, null)
})

test('an over-long reason is bounded', () => {
  const sink = createSilenceSink()
  sink.record({ reason: 'x'.repeat(5000) })
  assert.equal(sink.reason?.length, 500)
})

test('the descriptor tells the model silence is the normal outcome', () => {
  assert.equal(CONCLUDE_SILENTLY_DESCRIPTOR.toolName, CONCLUDE_SILENTLY_TOOL_NAME)
  // No required arguments: needing to justify silence would discourage it.
  assert.deepEqual(CONCLUDE_SILENTLY_DESCRIPTOR.inputSchema.required, [])
})
