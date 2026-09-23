import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'
import { BUILTIN_TOOL_DEFINITIONS } from '@nessie/runtime'
import { AgentTriggerTypeSchema } from '@nessie/schemas'

import { createAgentTrigger } from '../src/trigger-create.js'
import {
  RELEASED_TRIGGER_TYPES,
  UNRELEASED_TRIGGER_TYPES,
  unreleasedTriggerTypeRefusal,
} from '../src/trigger-type-availability.js'
import { createWorkflowTrigger } from '../src/workflow-trigger-create.js'

/**
 * `ticket_changed` and `document_changed` are in the enum before anything may
 * create one (Rule zero: nothing half-exposed). These pin the refusal at the
 * service floor, where no surface can route around it, and that no tool
 * definition a model reads offers either type.
 */

/** A client that fails the test the moment anything reads or writes. */
const untouchable = new Proxy({}, {
  get: (_target, property) => {
    throw new Error(`an unreleased type must be refused before prisma.${String(property)} is touched`)
  },
}) as PrismaClient

test('the unreleased types are exactly the two new ones, and the rest stay released', () => {
  assert.deepEqual([...UNRELEASED_TRIGGER_TYPES], ['ticket_changed', 'document_changed'])
  assert.deepEqual([...RELEASED_TRIGGER_TYPES], ['manual', 'scheduled', 'webhook', 'event', 'interval'])
  for (const type of AgentTriggerTypeSchema.options) {
    assert.equal(
      RELEASED_TRIGGER_TYPES.includes(type) !== UNRELEASED_TRIGGER_TYPES.includes(type),
      true,
      `${type} is either released or not, never both`,
    )
  }
})

test('the refusal names the type and what can be created instead', () => {
  for (const type of UNRELEASED_TRIGGER_TYPES) {
    assert.equal(
      unreleasedTriggerTypeRefusal(type),
      `${type} triggers cannot be created yet. Use one of: manual, scheduled, webhook, event, interval.`,
    )
  }
  for (const type of RELEASED_TRIGGER_TYPES) {
    assert.equal(unreleasedTriggerTypeRefusal(type), null)
  }
})

test('createAgentTrigger refuses each unreleased type before touching the database', async () => {
  for (const type of UNRELEASED_TRIGGER_TYPES) {
    const trigger = await createAgentTrigger(untouchable, randomUUID(), {
      config: { prompt: 'Pick up the ticket.' },
      targetChannelId: randomUUID(),
      type,
    })
    assert.equal(trigger, null, `${type} is refused`)
  }
})

test('createWorkflowTrigger refuses each unreleased type before touching the database', async () => {
  for (const type of UNRELEASED_TRIGGER_TYPES) {
    assert.equal(await createWorkflowTrigger(untouchable, randomUUID(), { type }), null, `${type} is refused`)
  }
})

test('no trigger-creating tool offers an unreleased type to a model', () => {
  const definitions = new Map(BUILTIN_TOOL_DEFINITIONS.map((definition) => [definition.id, definition]))
  for (const id of ['agent_trigger_create', 'workflow_trigger_create']) {
    const type = definitions.get(id)?.parameters.properties?.['type'] as { enum?: unknown[] } | undefined
    assert.ok(type?.enum, `${id} declares a type enum`)
    assert.deepEqual(
      [...type.enum].sort(),
      [...RELEASED_TRIGGER_TYPES].sort(),
      `${id} offers exactly the released types`,
    )
  }
})
