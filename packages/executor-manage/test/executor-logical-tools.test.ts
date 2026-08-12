import assert from 'node:assert/strict'
import test from 'node:test'

import {
  executorLogicalToolDefinitions,
  executorLogicalToolId,
} from '../src/index.js'

test('logical executor tools are stable operation names rather than machine projections', () => {
  const tools = executorLogicalToolDefinitions()
  assert.equal(tools.length, 15)
  assert.equal(new Set(tools.map((tool) => tool.key)).size, tools.length)
  assert.equal(executorLogicalToolId('command.run'), 'executor.command.run')
  assert.ok(tools.every((tool) => tool.label.length > 0 && tool.description.length > 0))
})
