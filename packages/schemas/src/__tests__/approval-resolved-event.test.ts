import assert from 'node:assert/strict'
import test from 'node:test'

import { ApprovalResolvedEventSchema } from '../realtime-ws.js'

// An approval opened by a paired MCP credential has no `Agent` row, so the
// resolve route publishes this event without an `agentId`.
//
// This is pinned in a test rather than left to the typechecker because the two
// halves of a WS event live apart: a TypeScript payload map and this zod
// schema. Making the field optional in the map alone compiles perfectly and
// fails at runtime — and it fails in the worst possible place. `publishWs`
// parses and throws, and the resolve route publishes *after* the approval has
// been written and its effect has run, so the mismatch turned a publish that
// genuinely happened into a 400 and told the person it had failed.
test('a resolved approval may carry no agent', () => {
  const parsed = ApprovalResolvedEventSchema.safeParse({
    approvalId: 'bd947914-b078-4402-90c9-2a07bd5b602b',
    outcome: 'approved',
    resolvedAt: new Date().toISOString(),
    resolverId: 'f00c9f4f-f1e3-4d2b-bd84-c6f9a9d40d0b',
    taskId: '00000000-0000-4000-8000-000000000000',
  })
  assert.ok(
    parsed.success,
    `an agentId-less resolution must publish: ${JSON.stringify(parsed.error?.issues)}`,
  )
})

test('an agent-opened approval still carries its agent', () => {
  const parsed = ApprovalResolvedEventSchema.safeParse({
    agentId: 'c2a96268-5840-458d-a9d3-5034f6a3b4eb',
    approvalId: 'bd947914-b078-4402-90c9-2a07bd5b602b',
    outcome: 'approved',
    resolvedAt: new Date().toISOString(),
    taskId: '00000000-0000-4000-8000-000000000000',
  })
  assert.ok(parsed.success, 'the ordinary agent path must be unchanged')
  assert.equal(parsed.data?.agentId, 'c2a96268-5840-458d-a9d3-5034f6a3b4eb')
})
