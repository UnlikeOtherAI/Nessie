import assert from 'node:assert/strict'
import test from 'node:test'

import {
  UNRELEASED_TRIGGER_TYPES,
  unreleasedTriggerTypeRefusal,
  workflowTriggerTypeRefusal,
} from '@nessie/team-admin'

import { runAgentTriggerCreateTool } from '../src/run/pa-tools/provisioning.js'
import { runWorkflowTriggerCreateTool } from '../src/run/pa-tools/workflow-authoring.js'

// The assistant's create tools parse the shared trigger body, whose type enum
// already knows `document_changed`. It is not released for agents, so
// agent_trigger_create refuses it with a sentence that says what to use
// instead — before resolving the acting member or reading anything.
// `ticket_changed` is released for agents (T1), and a workflow can never use
// either, so workflow_trigger_create refuses both.

const AGENT_ID = '40000000-0000-4000-8000-000000000001'
const INSTALLATION_ID = '40000000-0000-4000-8000-000000000002'

const context = new Proxy({}, {
  get: (_target, property) => {
    throw new Error(`an unreleased type must be refused before context.${String(property)} is read`)
  },
}) as Parameters<typeof runAgentTriggerCreateTool>[0]

test('agent_trigger_create refuses each unreleased type', async () => {
  assert.deepEqual([...UNRELEASED_TRIGGER_TYPES], ['document_changed'])
  for (const type of UNRELEASED_TRIGGER_TYPES) {
    const refusal = unreleasedTriggerTypeRefusal(type)
    assert.ok(refusal)
    await assert.rejects(runAgentTriggerCreateTool(context, { agentId: AGENT_ID, type }), { message: refusal })
  }
})

test('workflow_trigger_create refuses both agent-only types, released or not', async () => {
  for (const type of ['ticket_changed', 'document_changed'] as const) {
    const agentOnly = workflowTriggerTypeRefusal(type)
    assert.ok(agentOnly)
    await assert.rejects(
      runWorkflowTriggerCreateTool(context, { type, workflowInstallationId: INSTALLATION_ID }),
      { message: agentOnly },
    )
  }
})
