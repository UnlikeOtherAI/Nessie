import assert from 'node:assert/strict'
import test from 'node:test'
import {
  LOCAL_INFERENCE_ENABLED_SETTING_KEY,
  isAdminAuthoredScopedSettingKey,
  isLocalInferenceEnabledValue,
} from '../src/local-inference-policy.js'

test('only the typed local-inference setting is administrator-authored', () => {
  assert.equal(isAdminAuthoredScopedSettingKey(LOCAL_INFERENCE_ENABLED_SETTING_KEY), true)
  assert.equal(isAdminAuthoredScopedSettingKey('inference.localAgents.enabled.extra'), false)
  assert.equal(isAdminAuthoredScopedSettingKey('appearance.theme'), false)
})

test('local-inference enablement accepts booleans only', () => {
  assert.equal(isLocalInferenceEnabledValue(true), true)
  assert.equal(isLocalInferenceEnabledValue(false), true)
  assert.equal(isLocalInferenceEnabledValue('true'), false)
  assert.equal(isLocalInferenceEnabledValue(null), false)
})
