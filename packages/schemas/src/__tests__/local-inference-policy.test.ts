import assert from 'node:assert/strict'
import test from 'node:test'

import {
  LOCAL_INFERENCE_ENABLED_SETTING_KEY,
  LocalInferenceEnabledSettingValueSchema,
} from '../local-inference-policy.js'

test('the browser-safe local inference policy contract accepts only its exact boolean decision', () => {
  assert.equal(LOCAL_INFERENCE_ENABLED_SETTING_KEY, 'inference.localAgents.enabled')
  assert.equal(LocalInferenceEnabledSettingValueSchema.safeParse(true).success, true)
  assert.equal(LocalInferenceEnabledSettingValueSchema.safeParse(false).success, true)
  assert.equal(LocalInferenceEnabledSettingValueSchema.safeParse('true').success, false)
  assert.equal(LocalInferenceEnabledSettingValueSchema.safeParse(1).success, false)
})
