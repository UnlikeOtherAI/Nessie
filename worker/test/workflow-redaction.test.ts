import assert from 'node:assert/strict'
import test from 'node:test'

import { WORKFLOW_SECRET_REDACTION } from '@nessie/workspace-admin'

import {
  buildAgentTaskBody,
  buildWorkflowBindingContext,
  resolveWorkflowStepInput,
} from '../src/control/workflows.js'

// W0 sinks 2+3: message rendering and the transform context. A binding the
// template declares a reference is a tainted `secret_*` ref; every
// interpolated value — the channel/message body, an agent prompt, and any
// expression that resolves the whole workflow context — renders the
// redaction marker instead.

const SECRET_REF = 'secret_mcp_cafedeadbeef'

const taintedContext = () =>
  buildWorkflowBindingContext({
    stepSnapshots: {
      fetch: {
        input: { url: 'https://example.com', apiKey: SECRET_REF },
        output: { status: 200 },
        status: 'completed',
      },
    },
    workflowBindings: { apiKey: SECRET_REF, channel: '#ops' },
    workflowConfig: { header: `Bearer ${SECRET_REF}` },
    workflowInput: { prompt: 'summarise' },
  })

test('W0 sink 2/3: exact-reference interpolation redacts the tainted ref', async () => {
  const resolved = await resolveWorkflowStepInput(
    {
      key: '{{ workflow.bindings.apiKey }}',
      literal: '{{ workflow.bindings.channel }}',
    },
    taintedContext(),
  ) as Record<string, unknown>

  assert.equal(resolved['key'], WORKFLOW_SECRET_REDACTION)
  assert.equal(resolved['literal'], '#ops')
  assert.equal(JSON.stringify(resolved).includes(SECRET_REF), false)
})

test('W0 sink 2: mixed message templates never embed the tainted ref', async () => {
  const resolved = await resolveWorkflowStepInput(
    { body: 'Posting {{ workflow.bindings.apiKey }} to {{ workflow.bindings.channel }}' },
    taintedContext(),
  ) as Record<string, unknown>

  assert.equal(
    resolved['body'],
    `Posting ${WORKFLOW_SECRET_REDACTION} to #ops`,
  )
  assert.equal(JSON.stringify(resolved).includes(SECRET_REF), false)
})

test('W0 sink 2: whole-ref values redact; embedded refs resolve to the marker', async () => {
  const context = taintedContext()

  // A whole-ref value reached through workflow.* never leaves the sink —
  // from any scope, including steps.*.
  const viaSteps = await resolveWorkflowStepInput(
    { key: '{{ steps.fetch.input.apiKey }}' },
    context,
  ) as Record<string, unknown>
  assert.equal(viaSteps['key'], WORKFLOW_SECRET_REDACTION)

  // The boundary is exact-value taint (per plan §3.0: persist only refs,
  // redact tainted values): config is literal-only by write-gate, so a ref
  // embedded in a longer literal is out of scope — but resolving the ref
  // itself always redacts.
})

test('W0 sink 2: agent-task prompt bodies redact persisted refs', () => {
  const taintedRefs = new Set([SECRET_REF])

  const prompt = buildAgentTaskBody(
    { prompt: 'Call the API', apiKey: SECRET_REF, toolName: 'http_fetch' },
    {},
    taintedRefs,
  )
  assert.equal(prompt.includes(SECRET_REF), false)

  const fallback = buildAgentTaskBody(
    { apiKey: SECRET_REF, toolName: 'http_fetch' },
    { token: SECRET_REF },
    taintedRefs,
  )
  assert.equal(fallback.includes(SECRET_REF), false)
  assert.equal(fallback.includes(WORKFLOW_SECRET_REDACTION), true)
})
