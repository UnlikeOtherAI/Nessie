import assert from 'node:assert/strict'
import test from 'node:test'

import {
  isLandscape,
  LARGE_PHONE_LANDSCAPE_MIN_LONG_EDGE_DP,
  supportsLargePhoneLandscape,
} from './phone-orientation'

test('only Max-class iPhones can opt into landscape', () => {
  assert.equal(supportsLargePhoneLandscape({
    height: LARGE_PHONE_LANDSCAPE_MIN_LONG_EDGE_DP - 1,
    isPad: false,
    platform: 'ios',
    width: 430,
  }), false)
  assert.equal(supportsLargePhoneLandscape({
    height: 956,
    isPad: false,
    platform: 'ios',
    width: 440,
  }), true)
})

test('iPads and non-iOS shells keep their own orientation policies', () => {
  assert.equal(supportsLargePhoneLandscape({
    height: 1_024,
    isPad: true,
    platform: 'ios',
    width: 768,
  }), false)
  assert.equal(supportsLargePhoneLandscape({
    height: 1_000,
    isPad: false,
    platform: 'android',
    width: 500,
  }), false)
})

test('landscape is strictly wider than it is tall', () => {
  assert.equal(isLandscape({ height: 430, width: 956 }), true)
  assert.equal(isLandscape({ height: 956, width: 440 }), false)
})
