import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveAdvertisedOutputTokens, resolveMainOutputTokens } from './run-inference.js'

test('document compose never exceeds the loop-admitted output cap', () => {
  assert.equal(resolveMainOutputTokens({
    admittedMaxOutputTokens: 3_000,
    composeAvailable: true,
    configuredMaxTokens: 12_000,
  }), 3_000)
})

test('document compose keeps its configured desired size without a loop cap', () => {
  assert.equal(resolveMainOutputTokens({
    composeAvailable: true,
    configuredMaxTokens: 12_000,
  }), 32_768)
})

test('advertised Ledger output caps lower but never replace the configured cap', () => {
  assert.equal(resolveAdvertisedOutputTokens({ configuredMaxTokens: 12_000, ledgerMaxOutputTokens: 8_192 }), 8_192)
  assert.equal(resolveAdvertisedOutputTokens({ configuredMaxTokens: 12_000, staticMaxOutputTokens: 16_384 }), 12_000)
  assert.equal(resolveAdvertisedOutputTokens({ configuredMaxTokens: 12_000 }), 12_000)
})
