import assert from 'node:assert/strict'
import test from 'node:test'

import { IMPLEMENTED_EXECUTOR_OPERATION_KEYS } from '@nessie/schemas'

import {
  executorLogicalToolDefinitions,
  executorLogicalToolId,
} from '../src/index.js'

test('logical executor tools expose exactly the implemented operation set', () => {
  const tools = executorLogicalToolDefinitions()
  const offeredOperations = tools.map((tool) => tool.key)

  assert.deepEqual(offeredOperations, IMPLEMENTED_EXECUTOR_OPERATION_KEYS)
  assert.equal(new Set(offeredOperations).size, offeredOperations.length)
  assert.equal(executorLogicalToolId('file.read'), 'executor.file.read')
  assert.equal(executorLogicalToolId('command.run'), 'executor.command.run')
  assert.equal(executorLogicalToolId('browser.act'), 'executor.browser.act')
  assert.equal(executorLogicalToolId('workspace.review'), 'executor.workspace.review')
  const unavailableOperations = [
    'coding.attach',
    'coding.prompt',
    'coding.interrupt',
    'coding.close',
  ]
  assert.deepEqual(
    offeredOperations.filter((operation) => unavailableOperations.includes(operation)),
    [],
  )
  assert.ok(tools.every((tool) => tool.label.length > 0 && tool.description.length > 0))
})
