import assert from 'node:assert/strict'
import test from 'node:test'

import {
  localInferenceEnablementState,
} from '../src/components/features/local-inference/local-inference-enablement-state.js'

test('local inference stays disabled when no scope has opted in', () => {
  assert.deepEqual(localInferenceEnablementState(undefined), {
    canEdit: false,
    enabled: false,
    lockedHere: false,
    summary: 'Disabled until an organisation administrator enables it.',
  })
})

test('local inference names the effective scope instead of treating inheritance as a local edit', () => {
  assert.deepEqual(localInferenceEnablementState({
    canEdit: false,
    key: 'inference.localAgents.enabled',
    lockedAtScope: 'organization',
    lockedHere: false,
    setAtScope: 'organization',
    value: true,
  }), {
    canEdit: false,
    enabled: true,
    lockedHere: false,
    summary: 'Enabled at the organisation level.',
  })
})
