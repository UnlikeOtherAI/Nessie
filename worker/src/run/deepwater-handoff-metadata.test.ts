import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveDeepWaterHandoffMarker } from './deepwater-handoff-metadata.js'

const runId = '8f3a5a00-0e64-4d10-a517-0d0b69c1d801'

test('reads the exact durable run id from a DeepWater launch marker', () => {
  assert.deepEqual(resolveDeepWaterHandoffMarker({
    integrationLaunch: { productSlug: 'deep-water', runId },
  }), { kind: 'found', runId })
})

test('rejects a DeepWater marker whose durable run id is missing or invalid', () => {
  assert.deepEqual(resolveDeepWaterHandoffMarker({
    integrationLaunch: { productSlug: 'deep-water' },
  }), { kind: 'invalid' })
  assert.deepEqual(resolveDeepWaterHandoffMarker({
    integrationLaunch: { productSlug: 'deep-water', runId: 'not-a-uuid' },
  }), { kind: 'invalid' })
})

test('leaves ordinary and other-product messages unguarded', () => {
  assert.deepEqual(resolveDeepWaterHandoffMarker({}), { kind: 'none' })
  assert.deepEqual(resolveDeepWaterHandoffMarker({
    integrationLaunch: { productSlug: 'buildme', runId },
  }), { kind: 'none' })
})
