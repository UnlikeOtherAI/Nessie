import assert from 'node:assert/strict'
import test from 'node:test'

import { AGENT_HANDOFF_TOOL_ID, BUILTIN_TOOL_DEFINITIONS } from '@nessie/runtime'
import { AGENT_DESIGNER_SLUG } from '@nessie/workspace-admin'

import { authorizeToolCall, resolveAgentTools } from './tool-policy.js'
import { buildHandoffRoutingBlock } from './execute/handoff-routing.js'

/**
 * `agent_handoff`'s loop bounds are STRUCTURAL — decided in the authorization
 * layer, the way `spawn_subtask`'s recursion refusal is — so an agent that may
 * not hand off never sees the tool in its schema array at all. A runtime string
 * check inside the handler would leave it offered and then denied.
 */

const enabled = new Set(
  BUILTIN_TOOL_DEFINITIONS.filter((tool) => tool.requiresExplicitGrant !== true)
    .map((tool) => tool.id),
)

const resolve = (options: { agentSystemSlug?: string } = {}) =>
  resolveAgentTools(
    enabled,
    BUILTIN_TOOL_DEFINITIONS,
    null,
    null,
    'shared',
    { ...options, inlineToolLimit: BUILTIN_TOOL_DEFINITIONS.length },
  )

test('an ordinary shared agent is offered agent_handoff by default', () => {
  const offered = resolve()
  assert.equal(offered.allowedIds.has(AGENT_HANDOFF_TOOL_ID), true)
  assert.ok(
    offered.descriptors.some((descriptor) => descriptor.toolName === AGENT_HANDOFF_TOOL_ID),
  )
  assert.deepEqual(
    authorizeToolCall(
      AGENT_HANDOFF_TOOL_ID,
      enabled,
      BUILTIN_TOOL_DEFINITIONS,
      null,
      null,
      'shared',
    ),
    { allowed: true },
  )
})

test('a global agent never sees agent_handoff — not for itself, not for a peer', () => {
  const offered = resolve({ agentSystemSlug: AGENT_DESIGNER_SLUG })
  assert.equal(offered.allowedIds.has(AGENT_HANDOFF_TOOL_ID), false)
  assert.ok(
    !offered.descriptors.some((descriptor) => descriptor.toolName === AGENT_HANDOFF_TOOL_ID),
    'agent_handoff must be omitted from the schema array, not offered and denied',
  )
  assert.deepEqual(
    authorizeToolCall(
      AGENT_HANDOFF_TOOL_ID,
      enabled,
      BUILTIN_TOOL_DEFINITIONS,
      null,
      null,
      'shared',
      { agentSystemSlug: AGENT_DESIGNER_SLUG },
    ),
    { allowed: false, reason: 'global_agent_handoff_denied' },
  )
})

test('a spawn_subtask child may not hand off, exactly as it may not spawn', () => {
  const offered = resolveAgentTools(
    enabled,
    BUILTIN_TOOL_DEFINITIONS,
    null,
    'parent-agent-id',
    'shared',
    { inlineToolLimit: BUILTIN_TOOL_DEFINITIONS.length },
  )
  assert.equal(offered.allowedIds.has(AGENT_HANDOFF_TOOL_ID), false)
  assert.equal(offered.allowedIds.has('spawn_subtask'), false)
  assert.deepEqual(
    authorizeToolCall(
      AGENT_HANDOFF_TOOL_ID,
      enabled,
      BUILTIN_TOOL_DEFINITIONS,
      null,
      'parent-agent-id',
      'shared',
    ),
    { allowed: false, reason: 'parent_agent_subtask_denied' },
  )
})

test('an agent policy can still turn agent_handoff off, like any builtin', () => {
  assert.deepEqual(
    authorizeToolCall(
      AGENT_HANDOFF_TOOL_ID,
      enabled,
      BUILTIN_TOOL_DEFINITIONS,
      { [AGENT_HANDOFF_TOOL_ID]: false },
      null,
      'shared',
    ),
    { allowed: false, reason: 'agent_policy_denied' },
  )
})

test('the routing block is rendered from the registry, and only with the tool', () => {
  assert.equal(buildHandoffRoutingBlock({ hasHandoffTool: false }), null)

  const block = buildHandoffRoutingBlock({ hasHandoffTool: true })
  assert.ok(block)
  assert.ok(block.includes('Agent Designer'))
  assert.ok(block.includes(AGENT_DESIGNER_SLUG))
  assert.ok(block.includes('agent_handoff'))
})
