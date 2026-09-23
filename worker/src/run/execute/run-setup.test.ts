import assert from 'node:assert/strict'
import test from 'node:test'

import { BUILTIN_TOOL_DEFINITIONS, TODO_TOOL_DEFINITIONS } from '@nessie/runtime'

import { BUILTIN_STUB_INPUT_SCHEMA, BUILTIN_TOOL_SPEC_NAME } from '../builtin-toolset-deferred.js'
import { resolveAgentTools } from '../tool-policy.js'
import {
  holdsProjectWriteTools,
  resolveProjectDelegatedToolIds,
  resolveWithheldRunToolIds,
} from './run-setup.js'

const TODO_IDS = TODO_TOOL_DEFINITIONS.map((tool) => tool.id)

test('an ordinary turn of a to-do agent withholds nothing', () => {
  assert.deepEqual([...resolveWithheldRunToolIds({ isHandoffTurn: false, todosEnabled: true })], [])
})

test('a DeepWater launch turn withholds delegate, and a to-do-disabled agent its to-do builtins', () => {
  assert.deepEqual(
    [...resolveWithheldRunToolIds({ isHandoffTurn: true, todosEnabled: true })],
    ['delegate'],
  )
  assert.deepEqual(
    [...resolveWithheldRunToolIds({ isHandoffTurn: false, todosEnabled: false })].sort(),
    [...TODO_IDS].sort(),
  )
})

const resolve = (withheldToolIds: ReadonlySet<string>, policy: Record<string, boolean>) =>
  resolveAgentTools(
    new Set(BUILTIN_TOOL_DEFINITIONS.map((tool) => tool.id)),
    BUILTIN_TOOL_DEFINITIONS,
    policy,
    null,
    'shared',
    { inlineToolLimit: 20, withheldToolIds },
  )

// F15 edge: the exclusions used to run on the finished view. A withheld tool
// the policy granted `true` had already been promoted — spending the schema
// budget a real grant then lost — and the view's `tool_spec` decision was
// never taken again.
test('a withheld tool is gone before the deferred view is built', () => {
  const withheld = resolveWithheldRunToolIds({ isHandoffTurn: true, todosEnabled: false })
  const policy = Object.fromEntries(['delegate', ...TODO_IDS, 'send_message'].map((id) => [id, true]))
  const resolved = resolve(withheld, policy)

  for (const id of withheld) {
    assert.equal(resolved.allowedIds.has(id), false, `${id} is not allowed`)
    assert.equal(resolved.stubbedIds.has(id), false, `${id} is not a stub`)
    assert.equal(resolved.descriptors.some((tool) => tool.toolName === id), false, `${id} has no descriptor`)
  }
  // The grant beside them still arrives in full.
  const sendMessage = resolved.descriptors.find((tool) => tool.toolName === 'send_message')
  assert.ok(sendMessage)
  assert.notEqual(sendMessage.inputSchema, BUILTIN_STUB_INPUT_SCHEMA)
  // `tool_spec` is offered exactly while a stub remains to look up.
  assert.equal(resolved.toolSpecEnabled, resolved.stubbedIds.size > 0)
  assert.equal(
    resolved.descriptors.some((tool) => tool.toolName === BUILTIN_TOOL_SPEC_NAME),
    resolved.toolSpecEnabled,
  )
})

test('nothing withheld leaves delegate and the to-do builtins where the policy put them', () => {
  const resolved = resolve(new Set(), Object.fromEntries(['delegate', ...TODO_IDS].map((id) => [id, true])))
  for (const id of ['delegate', ...TODO_IDS]) {
    assert.ok(resolved.allowedIds.has(id), `${id} is allowed`)
  }
})

// F16: memory recall narrows on whether the run was offered a lent project
// tool that writes — not on what the policy says, nor on a read-only loan.
test('only a lent, offered, non-safe project tool counts as a project write', () => {
  const readOnly = resolveProjectDelegatedToolIds(true, { ticket_list: true, ticket_read: true })
  assert.equal(holdsProjectWriteTools(readOnly, new Set(readOnly)), false)

  const writes = resolveProjectDelegatedToolIds(true, { ticket_create: true, ticket_list: true })
  assert.equal(holdsProjectWriteTools(writes, new Set(writes)), true)
  // Lent but withheld from the offered toolset (a registry that disallows it).
  assert.equal(holdsProjectWriteTools(writes, new Set(['ticket_list'])), false)
  // Offered by another route (the Personal Assistant) but never lent.
  assert.equal(holdsProjectWriteTools(new Set(), new Set(['ticket_create'])), false)
  // No project delegation at all: nothing is lent whatever the policy grants.
  const none = resolveProjectDelegatedToolIds(false, { ticket_create: true })
  assert.equal(holdsProjectWriteTools(none, new Set(['ticket_create'])), false)
})
