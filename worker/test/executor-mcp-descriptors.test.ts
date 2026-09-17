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
  const unreachable = modelFacing.filter((key) => descriptorFor(key) === null)
  assert.deepEqual(
    unreachable,
    [],
    `these operations have a backend but no schema, so no model can call them: ${unreachable.join(', ')}`,
  )
})

test('mcp.tools takes a server and an optional cursor', () => {
  const descriptor = descriptorFor('mcp.tools')
  assert.ok(descriptor)
  const schema = descriptor.inputSchema as {
    properties: Record<string, unknown>
    required: string[]
  }
  assert.deepEqual(schema.required, ['server'])
  assert.ok('cursor' in schema.properties, 'a paged catalog needs a cursor')
})

test('mcp.call leaves the tool’s own arguments unconstrained', () => {
  // Mirroring a server's argument grammar here would drift the first time
  // that server ships a field; the daemon passes them through untouched.
  const descriptor = descriptorFor('mcp.call')
  assert.ok(descriptor)
  const schema = descriptor.inputSchema as {
    properties: { arguments?: Record<string, unknown> }
    required: string[]
  }
  assert.deepEqual(schema.required.sort(), ['server', 'tool'])
  assert.deepEqual(schema.properties.arguments, { type: 'object' })
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
