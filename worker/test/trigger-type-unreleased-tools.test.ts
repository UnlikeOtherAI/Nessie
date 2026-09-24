import assert from 'node:assert/strict'
import test from 'node:test'

import { UNRELEASED_TRIGGER_TYPES, workflowTriggerTypeRefusal } from '@nessie/team-admin'

import { runWorkflowTriggerCreateTool } from '../src/run/pa-tools/workflow-authoring.js'

// Every agent trigger type is released now (`ticket_changed` in T1,
// `document_changed` in T2), so agent_trigger_create refuses none by type. A
// workflow can never use either agent-only type, so workflow_trigger_create
// refuses both — before resolving the acting member or reading anything.

const INSTALLATION_ID = '40000000-0000-4000-8000-000000000002'

const context = new Proxy({}, {
  get: (_target, property) => {
    throw new Error(`an agent-only type must be refused before context.${String(property)} is read`)
  },
}) as Parameters<typeof runWorkflowTriggerCreateTool>[0]

test('no agent trigger type is left unreleased', () => {
  assert.deepEqual([...UNRELEASED_TRIGGER_TYPES], [])
})

test('workflow_trigger_create refuses both agent-only types', async () => {
  for (const type of ['ticket_changed', 'document_changed'] as const) {
    const agentOnly = workflowTriggerTypeRefusal(type)
    assert.ok(agentOnly)
    await assert.rejects(
      runWorkflowTriggerCreateTool(context, { type, workflowInstallationId: INSTALLATION_ID }),
      { message: agentOnly },
    )
  }
})
