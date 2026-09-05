import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildRunLimits,
  emptyRunLimitsForm,
  readAgentRunLimits,
  runLimitsToForm,
} from '../src/facades/designer/run-limits.js'

test('an all-blank fieldset saves null so stored limits are cleared', () => {
  assert.equal(buildRunLimits(emptyRunLimitsForm), null)
})

test('only the filled dimensions are sent; minutes become wallclock ms', () => {
  const limits = buildRunLimits({
    ...emptyRunLimitsForm,
    maxDurationMinutes: '45',
    maxTokens: '250000',
  })

  assert.deepEqual(limits, { maxTokens: 250000, maxWallclockMs: 2_700_000 })
})

test('non-positive, fractional and unparseable counts are treated as blank', () => {
  assert.equal(buildRunLimits({ ...emptyRunLimitsForm, maxTokens: '0' }), null)
  assert.equal(buildRunLimits({ ...emptyRunLimitsForm, maxTokens: '-5' }), null)
  assert.equal(buildRunLimits({ ...emptyRunLimitsForm, maxToolCalls: '2.5' }), null)
  assert.equal(buildRunLimits({ ...emptyRunLimitsForm, maxIterations: 'lots' }), null)
  assert.equal(buildRunLimits({ ...emptyRunLimitsForm, maxDurationMinutes: '0' }), null)
})

test('a fractional minute is still a whole number of milliseconds', () => {
  assert.deepEqual(
    buildRunLimits({ ...emptyRunLimitsForm, maxDurationMinutes: '1.5' }),
    { maxWallclockMs: 90_000 },
  )
})

test('stored limits round-trip through the form without drift', () => {
  const stored = {
    maxCostCents: 500,
    maxIterations: 40,
    maxTokens: 250000,
    maxToolCalls: 120,
    maxWallclockMs: 2_700_000,
  }

  assert.deepEqual(buildRunLimits(runLimitsToForm(stored)), stored)
  assert.equal(runLimitsToForm(stored).maxDurationMinutes, '45')
  assert.deepEqual(runLimitsToForm(null), emptyRunLimitsForm)
})

test('an agent record without usable run limits reads as none', () => {
  assert.equal(readAgentRunLimits(undefined), null)
  assert.equal(readAgentRunLimits({}), null)
  assert.equal(readAgentRunLimits({ runLimits: null }), null)
  assert.equal(readAgentRunLimits({ runLimits: { maxTokens: -1 } }), null)
  assert.deepEqual(readAgentRunLimits({ runLimits: { maxTokens: 10 } }), { maxTokens: 10 })
})
