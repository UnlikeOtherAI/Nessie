import assert from 'node:assert/strict'
import test from 'node:test'

import { IMPLEMENTED_EXECUTOR_OPERATION_KEYS } from '@nessie/schemas'

import { descriptorFor } from '../src/run/executor-toolset.js'

/**
 * Rule zero, at the last door: a capability nobody can call is unfinished.
 *
 * `descriptorFor` returns null for any operation without a model-facing
 * schema, and a null descriptor removes the tool from the run silently. The
 * daemon, the control plane and the admin can all be complete while the model
 * still cannot reach the operation, which is exactly what happened to
 * `mcp.tools` and `mcp.call` before this test existed.
 */

/**
 * Operations with a daemon backend that no model may call, each for a stated
 * reason. Anything reaching this list by accident rather than by decision is
 * the bug this file exists to catch, so removing an entry should be a
 * deliberate act with its reason removed too.
 */
const DELIBERATELY_UNREACHABLE: Record<string, string> = {
  // Only a person issues a reviewed promotion.
  'workspace.promote': 'a promotion is a human act',
  // The daemon implements these, but the control plane must not advertise the
  // bundle until it can prove the originating run is private and attach an
  // owner-only disclosure basis to every observation.
  'browser.connected.open': 'awaiting the private-run disclosure basis',
  'browser.connected.observe': 'awaiting the private-run disclosure basis',
  'browser.connected.act': 'awaiting the private-run disclosure basis',
}

test('every implemented operation a run can bind is reachable by a model', () => {
  const modelFacing = IMPLEMENTED_EXECUTOR_OPERATION_KEYS
    .filter((key) => !(key in DELIBERATELY_UNREACHABLE))
  // A run binds the local-apps pair only on a revision that names a program,
  // so the descriptors are asked with one, as the toolset asks them.
  const unreachable = modelFacing.filter((key) => descriptorFor(key, { mcpServers: ['kelpie'] }) === null)
  assert.deepEqual(
    unreachable,
    [],
    `these operations have a backend but no schema, so no model can call them: ${unreachable.join(', ')}`,
  )
})

test('mcp.tools takes one of the named programs and an optional tool, never a cursor', () => {
  // The worker walks the program's catalog pages itself and answers from the
  // whole catalog, so the model is never handed a cursor to thread back.
  const descriptor = descriptorFor('mcp.tools', { mcpServers: ['kelpie', 'ollama-search'] })
  assert.ok(descriptor)
  const schema = descriptor.inputSchema as {
    properties: Record<string, { enum?: string[] }>
    required: string[]
  }
  assert.deepEqual(schema.required, ['server'])
  assert.deepEqual(Object.keys(schema.properties).sort(), ['server', 'tool'])
  assert.deepEqual(schema.properties.server?.enum, ['kelpie', 'ollama-search'])
})

test('mcp.call leaves the tool’s own arguments unconstrained', () => {
  // Mirroring a server's argument grammar here would drift the first time
  // that server ships a field; the daemon passes them through untouched.
  const descriptor = descriptorFor('mcp.call', { mcpServers: ['kelpie'] })
  assert.ok(descriptor)
  const schema = descriptor.inputSchema as {
    properties: { arguments?: Record<string, unknown>; server?: { enum?: string[] } }
    required: string[]
  }
  assert.deepEqual(schema.required.sort(), ['server', 'tool'])
  assert.deepEqual(schema.properties.arguments, { type: 'object' })
  assert.deepEqual(schema.properties.server?.enum, ['kelpie'])
})

test('the mcp descriptions list the programs, with a line for the ones this release knows', () => {
  for (const operationKey of ['mcp.tools', 'mcp.call']) {
    const descriptor = descriptorFor(operationKey, { mcpServers: ['kelpie', 'ollama-search', 'label-printer'] })
    assert.ok(descriptor)
    const lines = descriptor.description.split('\n')
    assert.ok(lines.includes('- kelpie: a real browser on that machine'), descriptor.description)
    assert.ok(lines.includes('- ollama-search: web search through the owner\'s Ollama account'))
    // Any other named program is its name and nothing more.
    assert.ok(lines.includes('- label-printer'))
  }
})

test('a revision that names no program offers neither mcp tool', () => {
  assert.equal(descriptorFor('mcp.tools'), null)
  assert.equal(descriptorFor('mcp.call', { mcpServers: [] }), null)
})

test('an operation with no backend stays unreachable', () => {
  assert.equal(descriptorFor('coding.prompt'), null)
  assert.equal(descriptorFor('not.an.operation'), null)
})

test('the deliberately unreachable operations really are unreachable', () => {
  // The list above is a record of decisions, not a mute-button: if one of
  // these gains a schema, that is a capability becoming callable and this
  // test is where somebody is made to notice.
  for (const key of Object.keys(DELIBERATELY_UNREACHABLE)) {
    assert.equal(descriptorFor(key), null, `${key} became model-reachable`)
  }
})
