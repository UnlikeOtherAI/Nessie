import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveModelName, resolveRuntimeProvider } from './inference-provider.js'

test('DeepSeek uses its Ledger service id and default chat model', () => {
  assert.equal(resolveRuntimeProvider('DeepSeek'), 'deepseek')
  assert.equal(resolveModelName('deepseek'), 'deepseek-v4-flash')
})
