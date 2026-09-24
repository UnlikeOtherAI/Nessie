import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'
import { BUILTIN_TOOL_DEFINITIONS } from '@nessie/runtime'
import { AGENT_TRIGGER_INPUT_TYPES, AgentTriggerTypeSchema, describeAgentTriggerTypes } from '@nessie/schemas'

import {
  RELEASED_TRIGGER_TYPES,
  UNRELEASED_TRIGGER_TYPES,
  unreleasedTriggerTypeRefusal,
  WORKFLOW_TRIGGER_TYPES,
  workflowTriggerTypeRefusal,
} from '../src/trigger-type-availability.js'
import { createWorkflowTrigger } from '../src/workflow-trigger-create.js'

/**
 * `ticket_changed` (T1) and `document_changed` (T2) are each released with
 * their typed config, so no type the enum carries is unreleased any more.
 * These pin that the released types are exactly the typed config union's, and
 * that the tool definitions a model reads offer exactly those. Workflows are
 * gated by their own permanent allowlist, so releasing a type for agents never
 * opens it for a workflow installation.
 */

/** The two types that wake an agent's ticket or document work. */
const AGENT_ONLY_TYPES = ['ticket_changed', 'document_changed']

/** A client that fails the test the moment anything reads or writes. */
const untouchable = new Proxy({}, {
  get: (_target, property) => {
    throw new Error(`an agent-only type must be refused before prisma.${String(property)} is touched`)
  },
}) as PrismaClient

test('every type is released, and the released types are the typed config union\'s', () => {
  assert.deepEqual([...UNRELEASED_TRIGGER_TYPES], [])
  assert.deepEqual(
    [...RELEASED_TRIGGER_TYPES],
    ['manual', 'scheduled', 'webhook', 'event', 'interval', 'ticket_changed', 'document_changed'],
  )
  for (const type of AgentTriggerTypeSchema.options) {
    assert.equal(unreleasedTriggerTypeRefusal(type), null, `${type} is released`)
  }
  // Releasing a type and giving it an arm are one change.
  assert.deepEqual([...RELEASED_TRIGGER_TYPES].sort(), [...AGENT_TRIGGER_INPUT_TYPES].sort())
})

test('a workflow may be started only by the five general types', () => {
  assert.deepEqual([...WORKFLOW_TRIGGER_TYPES], ['manual', 'scheduled', 'webhook', 'event', 'interval'])
  for (const type of AgentTriggerTypeSchema.options) {
    const agentOnly = AGENT_ONLY_TYPES.includes(type)
    assert.equal(WORKFLOW_TRIGGER_TYPES.includes(type), !agentOnly, type)
    assert.equal(
      workflowTriggerTypeRefusal(type),
      agentOnly
        ? `${type} triggers start an agent's work, not a workflow. Use one of: manual, scheduled, webhook, event, interval.`
        : null,
    )
  }
})

test('createWorkflowTrigger refuses each agent-only type before touching the database', async () => {
  for (const type of AGENT_ONLY_TYPES) {
    const parsed = AgentTriggerTypeSchema.parse(type)
    assert.equal(await createWorkflowTrigger(untouchable, randomUUID(), { type: parsed }), null, `${type} is refused`)
  }
})

/** The `type` enum a builtin tool definition offers a model. */
const offeredTypes = (id: string): unknown[] => {
  const definition = BUILTIN_TOOL_DEFINITIONS.find((candidate) => candidate.id === id)
  const type = definition?.parameters.properties?.['type'] as { enum?: unknown[] } | undefined
  assert.ok(type?.enum, `${id} declares a type enum`)
  return [...type.enum].sort()
}

test('no trigger-creating tool offers a type its surface refuses', () => {
  assert.deepEqual(
    offeredTypes('agent_trigger_create'),
    [...RELEASED_TRIGGER_TYPES].sort(),
    'agent_trigger_create offers exactly the released types',
  )
  assert.deepEqual(
    offeredTypes('workflow_trigger_create'),
    [...WORKFLOW_TRIGGER_TYPES].sort(),
    'workflow_trigger_create offers exactly the workflow types',
  )
  assert.ok(offeredTypes('agent_trigger_create').includes('ticket_changed'))
  assert.ok(offeredTypes('agent_trigger_create').includes('document_changed'))
  assert.ok(!offeredTypes('workflow_trigger_create').includes('ticket_changed'))
  assert.ok(!offeredTypes('workflow_trigger_create').includes('document_changed'))
})

test('both agent trigger tools describe their config from the typed union, not by hand', () => {
  const configOf = (id: string): string => {
    const definition = BUILTIN_TOOL_DEFINITIONS.find((candidate) => candidate.id === id)
    const config = definition?.parameters.properties?.['config'] as { description?: string } | undefined
    assert.ok(config?.description, `${id} describes its config`)
    return config.description
  }
  for (const id of ['agent_trigger_create', 'agent_trigger_update']) {
    const description = configOf(id)
    for (const line of describeAgentTriggerTypes()) assert.ok(description.includes(line), `${id}: ${line}`)
    assert.match(description, /document_changed/)
  }
})
