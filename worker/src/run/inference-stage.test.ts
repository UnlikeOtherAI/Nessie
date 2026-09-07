import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveStageOutputTokens } from './inference-stage.js'

test('output admission honors a selected small model capability', () => {
  assert.equal(resolveStageOutputTokens({
    capabilityMaxOutputTokens: 2_048,
    configuredMaxOutputTokens: 12_000,
    requestedMaxOutputTokens: 8_000,
  }), 2_048)
})

test('output admission lets a larger selected model use its run allowance', () => {
  assert.equal(resolveStageOutputTokens({
    capabilityMaxOutputTokens: 32_000,
    configuredMaxOutputTokens: 12_000,
    requestedMaxOutputTokens: 18_000,
  }), 18_000)
})

test('unknown capability keeps the configured fallback', () => {
  assert.equal(resolveStageOutputTokens({
    configuredMaxOutputTokens: 12_000,
  }), 12_000)
})
