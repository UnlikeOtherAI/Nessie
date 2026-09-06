import assert from 'node:assert/strict'
import test from 'node:test'

import {
  matchesDeepWaterInstanceFilter,
  readDeepWaterInstanceFilter,
  type DeepWaterToolFilterCandidate,
} from '../src/facades/tools/deep-water-tool-filter.js'

const updater: DeepWaterToolFilterCandidate = {
  builtin: true,
  managedProductSlug: null,
  mcpInstanceId: null,
  toolId: 'deep_water_run_update',
}
const projection: DeepWaterToolFilterCandidate = {
  builtin: false,
  managedProductSlug: 'deep-water',
  mcpInstanceId: 'instance-a',
  toolId: 'mcp:deep-water:research_start',
}
const unrelated: DeepWaterToolFilterCandidate = {
  builtin: false,
  managedProductSlug: null,
  mcpInstanceId: 'instance-a',
  toolId: 'unrelated',
}

test('an absent parameter leaves the full registry visible', () => {
  const filter = readDeepWaterInstanceFilter(new URLSearchParams())

  assert.equal(filter, undefined)
  assert.equal(matchesDeepWaterInstanceFilter(unrelated, filter), true)
})

test('a present empty parameter shows only the canonical updater', () => {
  const filter = readDeepWaterInstanceFilter(
    new URLSearchParams('deepWaterInstance='),
  )

  assert.equal(filter, null)
  assert.equal(matchesDeepWaterInstanceFilter(updater, filter), true)
  assert.equal(matchesDeepWaterInstanceFilter(projection, filter), false)
  assert.equal(matchesDeepWaterInstanceFilter(unrelated, filter), false)
  assert.equal(
    matchesDeepWaterInstanceFilter({ ...updater, builtin: false }, filter),
    false,
  )
})

test('an instance parameter shows its projections plus the canonical updater', () => {
  const filter = readDeepWaterInstanceFilter(
    new URLSearchParams('deepWaterInstance=instance-a'),
  )

  assert.equal(filter, 'instance-a')
  assert.equal(matchesDeepWaterInstanceFilter(updater, filter), true)
  assert.equal(matchesDeepWaterInstanceFilter(projection, filter), true)
  assert.equal(matchesDeepWaterInstanceFilter(unrelated, filter), false)
  assert.equal(
    matchesDeepWaterInstanceFilter(
      { ...projection, mcpInstanceId: 'instance-b' },
      filter,
    ),
    false,
  )
  assert.equal(
    matchesDeepWaterInstanceFilter(
      { ...projection, managedProductSlug: 'private-copy' },
      filter,
    ),
    false,
  )
})
