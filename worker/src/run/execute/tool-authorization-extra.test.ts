import assert from 'node:assert/strict'
import test from 'node:test'

import { BUILTIN_TOOL_DEFINITIONS } from '@nessie/runtime'
import { reviewableToolSurface } from './auto-review.js'
import { approvalRule, autoReviewRule, denyRule } from './tool-authorization-test-fixtures.js'
import { RUN_ID, TASK_ID, delegatedDeniedOutput, deniedOutput, finalTurn, reviewerInvocations, runLoop, suspendedApproval, toolCallTurn } from './tool-authorization.test.js'


test('main MCP: a policy deny intercepts before dispatch and is audited', async () => {
  const harness = await runLoop({
    mcpTools: {
      mcp_fetch: { inputSummary: 'fetch', output: 'fetched', success: true },
    },
    rules: [denyRule('mcp_fetch')],
    toolName: 'mcp_fetch',
  })
  assert.deepEqual(harness.dispatchedMcp, [])
  const parsed = deniedOutput(harness.result, 'mcp_fetch')
  assert.equal(parsed['reason'], 'explicit_policy_deny')
  assert.ok(harness.fake.auditLog.createCalls > 0)
})

test('main MCP: an approval-required allow suspends before dispatch', async () => {
  const harness = await runLoop({
    mcpTools: {
      mcp_fetch: { inputSummary: 'fetch', output: 'fetched', success: true },
    },
    rules: [approvalRule('mcp_fetch')],
    toolName: 'mcp_fetch',
  })
  assert.deepEqual(harness.dispatchedMcp, [])
  assert.equal(suspendedApproval(harness.result, 'mcp_fetch'), 'approval-1')
})

test('auto-review classifies only unsafe builtins, remote MCP calls, and executor actuation', () => {
  const mcpNames = new Set(['mcp_publish', 'mcp_find_tools', 'mcp_load_tools', 'mcp_drop_tools'])
  const executorNames = new Set([
    'executor.browser.act',
    'executor.browser.observe',
    'executor.command.run',
    'executor.file.read',
  ])

  for (const builtin of BUILTIN_TOOL_DEFINITIONS) {
    assert.equal(
      reviewableToolSurface(builtin.id, { executorToolNames: executorNames, mcpToolNames: mcpNames }),
      builtin.safe ? null : 'builtin',
      builtin.id,
    )
  }
  assert.equal(reviewableToolSurface('mcp_publish', { executorToolNames: executorNames, mcpToolNames: mcpNames }), 'mcp')
  assert.equal(reviewableToolSurface('mcp_find_tools', { executorToolNames: executorNames, mcpToolNames: mcpNames }), null)
  assert.equal(reviewableToolSurface('mcp_load_tools', { executorToolNames: executorNames, mcpToolNames: mcpNames }), null)
  assert.equal(reviewableToolSurface('mcp_drop_tools', { executorToolNames: executorNames, mcpToolNames: mcpNames }), null)
  assert.equal(reviewableToolSurface('executor.browser.act', { executorToolNames: executorNames, mcpToolNames: mcpNames }), 'executor')
  assert.equal(reviewableToolSurface('executor.command.run', { executorToolNames: executorNames, mcpToolNames: mcpNames }), 'executor')
  assert.equal(reviewableToolSurface('executor.browser.observe', { executorToolNames: executorNames, mcpToolNames: mcpNames }), null)
  assert.equal(reviewableToolSurface('executor.file.read', { executorToolNames: executorNames, mcpToolNames: mcpNames }), null)
})

test('auto-review allows a live remote MCP call once and meters one utility invocation', async () => {
  const harness = await runLoop({
    mcpTools: {
      mcp_publish: { inputSummary: 'publish', output: 'published', success: true },
    },
    reviewer: 'allow',
    rules: [autoReviewRule('mcp_publish')],
    toolArgs: { content: 'pošlete to prosím, je to fakt důležitý!' },
    toolName: 'mcp_publish',
  })

  assert.deepEqual(harness.dispatchedMcp, ['mcp_publish'])
  assert.equal(reviewerInvocations(harness.invocationSink).length, 1)
  assert.equal(harness.fake.approvalRequests.length, 0)
  assert.deepEqual(harness.fake.taskEvents, [{
    eventType: 'tool.auto_reviewed',
    payload: { surface: 'mcp', toolName: 'mcp_publish', verdict: 'allow' },
    taskId: TASK_ID,
  }])
  assert.ok(harness.fake.auditLog.entries.some((entry) => (
    (entry['metadata'] as { autoReview?: { verdict?: string } })?.autoReview?.verdict === 'allow'
  )))
})

test('auto-review denies a real MCP call without dispatching it', async () => {
  const harness = await runLoop({
    mcpTools: {
      mcp_publish: { inputSummary: 'publish', output: 'published', success: true },
    },
    reviewer: 'deny',
    rules: [autoReviewRule('mcp_publish')],
    toolName: 'mcp_publish',
  })

  assert.deepEqual(harness.dispatchedMcp, [])
  assert.equal(deniedOutput(harness.result, 'mcp_publish')['reason'], 'auto_review_denied')
  assert.equal(reviewerInvocations(harness.invocationSink).length, 1)
  assert.equal(harness.fake.approvalRequests.length, 0)
})

for (const [reviewer, expectedReason] of [
  ['unavailable', 'The automated reviewer was unavailable, so a human must decide.'],
  ['unparseable', 'The automated reviewer could not produce a reliable decision.'],
] as const) {
  test(`auto-review ${reviewer} fails closed to an approval`, async () => {
    const harness = await runLoop({
      mcpTools: {
        mcp_publish: { inputSummary: 'publish', output: 'published', success: true },
      },
      reviewer,
      rules: [autoReviewRule('mcp_publish')],
      toolName: 'mcp_publish',
    })

    assert.deepEqual(harness.dispatchedMcp, [])
    assert.equal(suspendedApproval(harness.result, 'mcp_publish'), 'approval-1')
    assert.equal(
      harness.fake.approvalRequests[0]?.['reason'],
      `Automated review asked for approval before mcp_publish: ${expectedReason}`,
    )
  })
}

// --- main executor ---

test('main executor: a policy deny intercepts before dispatch and is audited', async () => {
  const harness = await runLoop({
    executorTools: {
      'executor.file.read': { inputSummary: 'read', output: 'read', success: true },
    },
    rules: [denyRule('executor.file.read')],
    toolName: 'executor.file.read',
  })
  assert.deepEqual(harness.dispatchedExecutor, [])
  const parsed = deniedOutput(harness.result, 'executor.file.read')
  assert.equal(parsed['reason'], 'explicit_policy_deny')
  assert.ok(harness.fake.auditLog.createCalls > 0)
})

test('main executor: an approval-required allow suspends before dispatch', async () => {
  const harness = await runLoop({
    executorTools: {
      'executor.file.read': { inputSummary: 'read', output: 'read', success: true },
    },
    rules: [approvalRule('executor.file.read')],
    toolName: 'executor.file.read',
  })
  assert.deepEqual(harness.dispatchedExecutor, [])
  assert.equal(suspendedApproval(harness.result, 'executor.file.read'), 'approval-1')
})

test('main executor: browser act writes a bounded audit-chain entry after dispatch', async () => {
  const harness = await runLoop({
    executorTools: {
      'executor.browser.act': {
        inputSummary: 'click button',
        output: '{"status":"acted"}',
        success: true,
        toolCallRecordId: 'tool-call-1',
      },
    },
    toolArgs: { action: 'click', nodeId: 42, text: 'must not enter the audit chain' },
    toolName: 'executor.browser.act',
  })

  assert.ok(harness.dispatchedExecutor.length > 0)
  const entries = harness.fake.auditLog.entries.filter(
    (entry) => entry['action'] === 'executor.browser.action.dispatched',
  )
  assert.ok(entries.length > 0)
  assert.deepEqual(entries[0]?.['metadata'], {
    action: 'click',
    nodeId: 42,
    runId: RUN_ID,
    toolCallId: 'call-1',
  })
  assert.equal(entries[0]?.['resourceId'], 'tool-call-1')
})

test('main executor: command run audits only the argv program, never its arguments', async () => {
  const harness = await runLoop({
    executorTools: {
      'executor.command.run': {
        inputSummary: 'run command',
        output: '{"exitCode":0}',
        success: true,
        toolCallRecordId: 'tool-call-2',
      },
    },
    toolArgs: { args: ['--token=not-for-audit'], program: 'tool' },
    toolName: 'executor.command.run',
  })

  const entries = harness.fake.auditLog.entries.filter(
    (entry) => entry['action'] === 'executor.command.run.dispatched',
  )
  assert.ok(entries.length > 0)
  assert.deepEqual(entries[0]?.['metadata'], {
    program: 'tool',
    runId: RUN_ID,
    toolCallId: 'call-1',
  })
})

// --- delegated paths: the model calls delegate; the sub-agent then calls the
// nested tool, whose authorization context is rebuilt for the nested name ---

test('delegated builtin: a policy deny intercepts the nested call before dispatch', async () => {
  const harness = await runLoop({
    rules: [denyRule('kb_search')],
    subAgentTurns: [
      toolCallTurn('kb_search', { query: 'secret' }),
      finalTurn('sub-agent answer'),
    ],
    toolArgs: { task: 'look something up' },
    toolName: 'delegate',
  })
  const parsed = delegatedDeniedOutput(harness, 'kb_search')
  assert.equal(parsed['reason'], 'explicit_policy_deny')
  // The nested context must be the builtin's own name, not `delegate`.
  assert.ok(harness.fake.ruleLog.includes('kb_search'))
})

test('delegated builtin: an approval-required allow intercepts the nested call', async () => {
  const harness = await runLoop({
    rules: [approvalRule('kb_search')],
    subAgentTurns: [
      toolCallTurn('kb_search', { query: 'secret' }),
      finalTurn('sub-agent answer'),
    ],
    toolArgs: { task: 'look something up' },
    toolName: 'delegate',
  })
  const parsed = delegatedDeniedOutput(harness, 'kb_search')
  assert.equal(parsed['reason'], 'approval_required')
})

test('delegated MCP: a policy deny intercepts the nested call before dispatch', async () => {
  const harness = await runLoop({
    mcpTools: {
      mcp_fetch: { inputSummary: 'fetch', output: 'fetched', success: true },
    },
    rules: [denyRule('mcp_fetch')],
    subAgentTurns: [
      toolCallTurn('mcp_fetch', { url: 'https://example.com' }),
      finalTurn('sub-agent answer'),
    ],
    toolArgs: { task: 'fetch a page' },
    toolName: 'delegate',
  })
  assert.deepEqual(harness.dispatchedMcp, [])
  const parsed = delegatedDeniedOutput(harness, 'mcp_fetch')
  assert.equal(parsed['reason'], 'explicit_policy_deny')
})

test('delegated MCP: an approval-required allow intercepts the nested call', async () => {
  const harness = await runLoop({
    mcpTools: {
      mcp_fetch: { inputSummary: 'fetch', output: 'fetched', success: true },
    },
    rules: [approvalRule('mcp_fetch')],
    subAgentTurns: [
      toolCallTurn('mcp_fetch', { url: 'https://example.com' }),
      finalTurn('sub-agent answer'),
    ],
    toolArgs: { task: 'fetch a page' },
    toolName: 'delegate',
  })
  assert.deepEqual(harness.dispatchedMcp, [])
  const parsed = delegatedDeniedOutput(harness, 'mcp_fetch')
  assert.equal(parsed['reason'], 'approval_required')
})
