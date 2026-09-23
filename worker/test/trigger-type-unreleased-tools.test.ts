import assert from 'node:assert/strict'
import test from 'node:test'

import { UNRELEASED_TRIGGER_TYPES, unreleasedTriggerTypeRefusal } from '@nessie/team-admin'

import { runAgentTriggerCreateTool } from '../src/run/pa-tools/provisioning.js'
import { runWorkflowTriggerCreateTool } from '../src/run/pa-tools/workflow-authoring.js'

// The assistant's create tools parse the shared trigger body, whose type enum
// already knows `ticket_changed` and `document_changed`. Neither type is
// released, so both tools refuse it with the one sentence that says what to use
// instead — before resolving the acting member or reading anything.

const AGENT_ID = '40000000-0000-4000-8000-000000000001'
const INSTALLATION_ID = '40000000-0000-4000-8000-000000000002'

const context = new Proxy({}, {
  get: (_target, property) => {
    throw new Error(`an unreleased type must be refused before context.${String(property)} is read`)
  },
}) as Parameters<typeof runAgentTriggerCreateTool>[0]

test('agent_trigger_create and workflow_trigger_create refuse each unreleased type', async () => {
  for (const type of UNRELEASED_TRIGGER_TYPES) {
    const refusal = unreleasedTriggerTypeRefusal(type)
    assert.ok(refusal)
    await assert.rejects(runAgentTriggerCreateTool(context, { agentId: AGENT_ID, type }), { message: refusal })
    await assert.rejects(
      runWorkflowTriggerCreateTool(context, { type, workflowInstallationId: INSTALLATION_ID }),
      { message: refusal },
    )
  }
})
