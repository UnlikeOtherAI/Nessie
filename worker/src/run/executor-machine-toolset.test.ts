import assert from 'node:assert/strict'
import test from 'node:test'
import { combineExecutorToolsets } from './executor-machine-toolset.js'
import type { ExecutorToolset } from './executor-toolset.js'

const fixture = (executorId: string, calls: unknown[], toolName = 'terminal_session_start'): ExecutorToolset => {
  const descriptors = [{
    toolName, description: `Terminal on ${executorId}`,
    inputSchema: { type: 'object', properties: { root: { type: 'string', enum: [executorId] } }, required: ['root'] },
  }]
  return {
    descriptors, handledNames: new Set([toolName]),
    codingSessions: {
      descriptors, server: 'coding-sessions',
      execute: async (name, args, callId, hooks) => {
        calls.push({ executorId, name, args, callId, hooks })
        return { inputSummary: '', output: executorId, success: true }
      },
    },
    dispatch: async (name, args, callId) => {
      calls.push({ executorId, name, args, callId })
      return { inputSummary: '', output: executorId, success: true }
    },
    mcpCatalog: async () => ({ failure: { inputSummary: '', output: executorId, success: false } }),
    timeoutErrorFor: () => new Error(executorId), timeoutMsFor: () => 30_000,
  }
}

test('a tool call targets exactly one machine and preserves coding-session hooks', async () => {
  const calls: unknown[] = []
  const toolset = combineExecutorToolsets(['windows', 'mac', 'linux'].map((executorId) => ({
    executorId, label: executorId, toolset: fixture(executorId, calls),
  })))
  const schema = toolset.descriptors[0]!.inputSchema
  assert.deepEqual(schema.required, ['executorId', 'root'])
  assert.deepEqual((schema.properties as Record<string, unknown>).executorId,
    { type: 'string', enum: ['windows', 'mac', 'linux'] })
  const hooks = { signal: new AbortController().signal }
  const result = await toolset.codingSessions!.execute(
    'terminal_session_start', { executorId: 'linux', root: 'linux' }, 'call-1', hooks,
  )
  assert.equal(result.output, 'linux')
  assert.deepEqual(calls, [{
    executorId: 'linux', name: 'terminal_session_start', args: { root: 'linux' }, callId: 'call-1', hooks,
  }])
  assert.equal(toolset.timeoutErrorFor('terminal_session_start', 'call-1')?.message, 'linux')
  const catalog = await toolset.mcpCatalog('app', 'call-2', 'mac')
  assert.ok('failure' in catalog)
  assert.equal(catalog.failure.output, 'mac')
})

test('missing, foreign and unsupported machine choices never dispatch a command', async () => {
  const calls: unknown[] = []
  const toolset = combineExecutorToolsets([
    { executorId: 'windows', label: 'Minis', toolset: fixture('windows', calls) },
    { executorId: 'mac', label: 'Mac', toolset: fixture('mac', calls, 'coding_session_start') },
  ])
  for (const executorId of [undefined, 'foreign', 'mac']) {
    const result = await toolset.codingSessions!.execute('terminal_session_start', { executorId }, 'bad')
    assert.equal(result.success, false)
    assert.equal(result.correctable, true)
  }
  assert.deepEqual(calls, [])
})
