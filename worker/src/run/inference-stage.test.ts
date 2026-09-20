import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveStageOutputTokens } from './inference-stage.js'

test('output admission honors a selected small model capability', () => {
  assert.equal(resolveStageOutputTokens({
    capabilityMaxOutputTokens: 2_048,
    requestedMaxOutputTokens: 8_000,
  }), 2_048)
})

test('output admission lets a larger selected model use its run allowance', () => {
  assert.equal(resolveStageOutputTokens({
    capabilityMaxOutputTokens: 32_000,
    requestedMaxOutputTokens: 18_000,
  }), 18_000)
})

test('an unbounded conversational turn omits an output-token request', () => {
  assert.equal(resolveStageOutputTokens({}), undefined)
})

test('Kimi receives its advertised protocol maximum when its Messages API requires it', () => {
  assert.equal(resolveStageOutputTokens({
    capabilityMaxOutputTokens: 32_000, requiresProviderOutputLimit: true,
  }), 32_000)
})
